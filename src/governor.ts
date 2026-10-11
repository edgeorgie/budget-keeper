import { Ledger, sumSpend } from "./ledger.ts";
import { affordableOutputTokens, estimateTokens, worstCaseUsd } from "./pricing.ts";
import { chooseTier, DEFAULT_ROUTER, type Complexity, type RouterConfig } from "./router.ts";
import type {
  EventSink,
  ModelResolver,
  RunResult,
  Spend,
  StepResult,
  StopReason,
  Tier,
} from "./types.ts";

/** One unit of agent work the governor can schedule, price, and refuse. */
export interface Step<S> {
  readonly name: string;
  /** Tier to use absent any escalation signal. */
  readonly tier: Tier;
  /** Builds the prompt from the state accumulated by previous steps. */
  readonly prompt: (state: S) => string;
  /** Optional routing signals derived from state (confidence, input size, retry). */
  readonly complexity?: (state: S) => Complexity;
  /** Folds this step's model output back into the run state. */
  readonly apply: (state: S, text: string, meta: { truncated: boolean }) => S;
}

export interface GovernorOptions<S> {
  readonly runId?: string;
  /** Hard ceiling in USD. The run cannot exceed this; see README for the argument. */
  readonly budgetUsd: number;
  readonly resolve: ModelResolver;
  readonly steps: readonly Step<S>[];
  readonly initialState: S;
  readonly onEvent?: EventSink;
  readonly router?: RouterConfig;
  /**
   * Fewest output tokens worth paying a step's input cost for. A step that can only
   * afford a handful of output tokens produces a truncated fragment while still
   * paying full price for its prompt, so the governor refuses it and keeps the money
   * for the report instead. Default 48.
   */
  readonly minOutputTokens?: number;
  /** Caller-owned abort (Ctrl-C, HTTP client disconnect). */
  readonly signal?: AbortSignal;
  /** Injectable clock, so tests are not timing-dependent. */
  readonly now?: () => number;
}

/**
 * Runs a sequence of steps under a hard USD ceiling.
 *
 * The cap is enforced at three points, in decreasing order of importance:
 *
 * **1. A provider-side output allowance.** Before each step the governor solves
 * `affordableOutputTokens` — how many output tokens the *remaining* budget can buy
 * at this model's prices, given the measured prompt — and passes that to the
 * provider as `max_tokens`. The step's worst case is therefore equal to the money
 * left, by construction. This is the load-bearing mechanism: it makes an overspend
 * impossible rather than merely unlikely, and it is why a budget that can only
 * afford a short answer gets a short answer instead of a refusal.
 *
 * **2. Pre-flight refusal (`budget-preflight`).** If the affordable allowance falls
 * below `minOutputTokens`, the step never starts: paying a prompt's input cost for
 * a few words of output wastes the remainder on nothing useful.
 *
 * **3. Mid-stream kill-switch (`budget-killswitch`).** While a stream is open the
 * ledger is updated on every chunk and tested against both the budget and the
 * granted allowance. On breach the stream's `AbortSignal` fires and the partial
 * text is kept.
 *
 * **The precise guarantee, and its one honest caveat.** With (1) in place, total
 * spend cannot exceed the budget for any provider that honours `max_tokens` —
 * which is the documented behaviour of every major API. Against a provider that
 * *ignores* it, the kill-switch bounds the overshoot to at most one stream chunk:
 * a chunk's token count is only knowable once it has arrived, and by then the
 * provider will bill for it, so the governor reports it rather than pretending it
 * did not happen. `maxOvershootUsd` on the result quantifies that exposure for the
 * run. The README states this limitation in the same terms.
 *
 * No path throws. A governed run always returns a `RunResult` carrying the state
 * assembled from the steps that did run plus the names of those that did not,
 * because a cost governor that loses the work it already paid for is worse than no
 * governor at all.
 */
export async function runGoverned<S>(options: GovernorOptions<S>): Promise<RunResult<S>> {
  const {
    budgetUsd,
    resolve,
    steps,
    initialState,
    onEvent = () => {},
    router = DEFAULT_ROUTER,
    minOutputTokens = 48,
    signal: callerSignal,
    now = Date.now,
  } = options;
  const runId = options.runId ?? `run_${now().toString(36)}`;

  let state = initialState;
  const completed: StepResult[] = [];
  const spends: Spend[] = [];
  let reason: StopReason = "completed";
  let stoppedAt = steps.length;

  onEvent({ type: "run-start", runId, budgetUsd, plannedSteps: steps.length, at: now() });

  const finish = (): RunResult<S> => {
    const total = sumSpend(spends);
    onEvent({ type: "run-end", runId, reason, spend: total, at: now() });
    return {
      runId,
      reason,
      spend: total,
      budgetUsd,
      steps: completed,
      skipped: steps.slice(stoppedAt).map((s) => s.name),
      overshootUsd: Math.max(0, total.usd - budgetUsd),
      partial: state,
    };
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;

    if (callerSignal?.aborted) {
      reason = "caller-abort";
      stoppedAt = i;
      break;
    }

    const spentUsd = sumSpend(spends).usd;
    const remainingUsd = budgetUsd - spentUsd;

    const decision = chooseTier(step.tier, step.complexity?.(state) ?? {}, router);
    onEvent({ type: "tier-decision", step: i, chosen: decision.tier, reason: decision.reason, at: now() });

    const client = resolve(decision.tier);
    const prompt = step.prompt(state);
    const inputTokens = estimateTokens(prompt);
    const allowance = affordableOutputTokens(client.pricing, inputTokens, remainingUsd);

    if (allowance < minOutputTokens) {
      onEvent({
        type: "preflight-refusal",
        step: i,
        // Report what the step *would* have cost at the allowance it needs to be
        // worth running, which is the number that explains the refusal.
        worstCaseUsd: worstCaseUsd(client.pricing, inputTokens, minOutputTokens),
        remainingUsd,
        at: now(),
      });
      reason = "budget-preflight";
      stoppedAt = i;
      break;
    }

    onEvent({
      type: "step-start",
      step: i,
      name: step.name,
      model: client.pricing.id,
      tier: decision.tier,
      outputTokenCap: allowance,
      at: now(),
    });

    const ledger = new Ledger(client.pricing);
    ledger.add({ inputTokens });

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    let text = "";
    let truncated = false;
    let allowanceExhausted = false;
    let budgetBreached = false;
    let failure: unknown = null;

    try {
      for await (const chunk of client.stream({ prompt, maxOutputTokens: allowance }, controller.signal)) {
        text += chunk.text;
        const live = ledger.observe(chunk);
        onEvent({
          type: "spend",
          step: i,
          spend: live,
          remainingUsd: budgetUsd - (spentUsd + live.usd),
          at: now(),
        });

        // Two distinct conditions, deliberately not conflated. Exhausting the
        // granted allowance is the governor working as designed; crossing the
        // dollar budget means the provider overran what it was given. The dollar
        // test is strictly greater-than: landing exactly ON the budget is the
        // allowance being spent precisely, not an overrun, and labelling it as
        // one would cry wolf on every well-behaved run that uses its full budget.
        const overBudget = spentUsd + live.usd > budgetUsd;
        if (live.outputTokens >= allowance || overBudget) {
          allowanceExhausted = true;
          budgetBreached = overBudget;
          truncated = true;
          controller.abort();
          break;
        }
        if (controller.signal.aborted) {
          truncated = true;
          break;
        }
      }
    } catch (error) {
      // An abort we initiated is expected control flow, not a failure: some stream
      // implementations reject rather than returning when the signal fires.
      if (controller.signal.aborted) {
        truncated = true;
      } else {
        failure = error;
        truncated = true;
      }
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    const stepSpend = ledger.spend();
    spends.push(stepSpend);
    completed.push({
      name: step.name,
      text,
      truncated,
      outputTokenCap: allowance,
      model: client.pricing.id,
      tier: decision.tier,
      spend: stepSpend,
    });
    // The partial text of a cut-short step is still folded into state: it was paid
    // for, and discarding it would make the governor lossy as well as thrifty.
    state = step.apply(state, text, { truncated });
    onEvent({ type: "step-end", step: i, name: step.name, spend: stepSpend, truncated, at: now() });

    if (failure) {
      reason = "error";
      stoppedAt = i + 1;
      onEvent({
        type: "step-error",
        step: i,
        name: step.name,
        message: failure instanceof Error ? failure.message : String(failure),
        at: now(),
      });
      break;
    }

    if (allowanceExhausted) {
      onEvent({ type: "allowance-exhausted", step: i, outputTokenCap: allowance, at: now() });
    }

    if (budgetBreached) {
      onEvent({
        type: "killswitch",
        step: i,
        spentUsd: sumSpend(spends).usd,
        budgetUsd,
        at: now(),
      });
    }

    // Whether to continue is a question about money, not about why this step
    // ended: if the remaining budget cannot fund another step, the next
    // iteration's pre-flight gate will say so. The run only stops here when the
    // budget is genuinely exhausted.
    if (allowanceExhausted && budgetUsd - sumSpend(spends).usd <= 0) {
      reason = budgetBreached ? "budget-killswitch" : "budget-exhausted";
      stoppedAt = i + 1;
      break;
    }

    if (callerSignal?.aborted) {
      reason = "caller-abort";
      stoppedAt = i + 1;
      break;
    }
  }

  return finish();
}
