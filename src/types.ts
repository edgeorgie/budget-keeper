/**
 * Core domain types for the cost governor.
 *
 * The central idea the rest of the codebase is organised around: a *step* is the unit
 * of work an agent performs, a *stream* is how a model answers a step, and money is
 * spent continuously while that stream is open. Everything here exists so that spend
 * can be observed and halted *during* a stream rather than reconciled after it closes.
 */

/** A model tier. Tier ordering is meaningful: `cheap` < `mid` < `strong`. */
export type Tier = "cheap" | "mid" | "strong";

export const TIER_ORDER: readonly Tier[] = ["cheap", "mid", "strong"] as const;

/** Per-million-token USD prices, quoted the way vendors quote them. */
export interface ModelPricing {
  /** Vendor model identifier, e.g. `claude-haiku-4-5`. */
  readonly id: string;
  readonly tier: Tier;
  /** USD per 1,000,000 input tokens. */
  readonly inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  readonly outputPerMTok: number;
  /**
   * Upper bound on output tokens this model will be allowed to emit in one step.
   * Used by the pre-flight check to compute a *worst-case* cost before any token is
   * spent, which is what makes the budget a hard cap rather than a hopeful one.
   */
  readonly maxOutputTokens: number;
}

/** A single observation of token usage. Deltas, not totals — the meter accumulates. */
export interface UsageDelta {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Cumulative usage and its USD valuation at a point in time. */
export interface Spend {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}

/** Why a run stopped. */
export type StopReason =
  /** Every planned step completed within budget. */
  | "completed"
  /** A step was refused *before* it started because its allowance was too small. */
  | "budget-preflight"
  /**
   * The budget was spent down to zero by steps that each stayed within the
   * allowance they were granted. The intended terminal state of a run whose task
   * is larger than its budget — the governor spent exactly what it had.
   */
  | "budget-exhausted"
  /**
   * A stream was aborted *mid-flight* because live spend crossed the budget. Only
   * reachable when a provider overruns the `max_tokens` it was given.
   */
  | "budget-killswitch"
  /** The caller aborted (Ctrl-C, HTTP disconnect, test harness). */
  | "caller-abort"
  /** A step threw and the error was not recoverable. */
  | "error";

/** Emitted by the governor so a dashboard/CLI can render spend as it happens. */
export type GovernorEvent =
  | { type: "run-start"; runId: string; budgetUsd: number; plannedSteps: number; at: number }
  | {
      type: "step-start";
      step: number;
      name: string;
      model: string;
      tier: Tier;
      /** Output-token allowance the remaining budget could buy for this step. */
      outputTokenCap: number;
      at: number;
    }
  | { type: "tier-decision"; step: number; chosen: Tier; reason: string; at: number }
  | { type: "spend"; step: number; spend: Spend; remainingUsd: number; at: number }
  | { type: "step-end"; step: number; name: string; spend: Spend; truncated: boolean; at: number }
  | { type: "step-error"; step: number; name: string; message: string; at: number }
  | {
      /**
       * A step used the entire output allowance the governor granted it. Normal,
       * expected operation — not a budget emergency. Kept distinct from
       * `killswitch` so an operator reading the log can tell "the governor spent
       * exactly what it planned" apart from "something overran its limit".
       */
      type: "allowance-exhausted";
      step: number;
      outputTokenCap: number;
      at: number;
    }
  | {
      /**
       * Live spend crossed the budget while a stream was open, and the stream was
       * aborted. Only reachable when a provider overruns the `max_tokens` it was
       * given, so this appearing in a log is a signal about the provider.
       */
      type: "killswitch";
      step: number;
      spentUsd: number;
      budgetUsd: number;
      at: number;
    }
  | { type: "preflight-refusal"; step: number; worstCaseUsd: number; remainingUsd: number; at: number }
  | { type: "run-end"; runId: string; reason: StopReason; spend: Spend; at: number };

export type EventSink = (event: GovernorEvent) => void;

/** One chunk of a model response. */
export interface StreamChunk {
  readonly text: string;
  /** Usage *since the previous chunk*, if the provider reports it. */
  readonly usage?: UsageDelta;
}

/** A request for one model turn, with a governor-imposed output ceiling. */
export interface StreamRequest {
  readonly prompt: string;
  /**
   * Hard upper bound on output tokens for this turn, computed by the governor from
   * the budget actually remaining. Passed through to the provider (`max_tokens`),
   * which is what makes the USD ceiling enforceable rather than merely monitored:
   * a provider that honours it cannot emit enough tokens to breach the budget.
   */
  readonly maxOutputTokens: number;
}

/** A model call, as the governor needs to see it: streaming, abortable, priced. */
export interface ModelClient {
  readonly pricing: ModelPricing;
  stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

/** Resolves a tier to a concrete, priced, streaming client. */
export type ModelResolver = (tier: Tier) => ModelClient;

/** The outcome of one governed step. */
export interface StepResult {
  readonly name: string;
  readonly text: string;
  /**
   * True when the step did not get to finish on its own terms — either the output
   * allowance the governor could afford ran out, or the kill-switch cut the stream.
   */
  readonly truncated: boolean;
  /** The output-token allowance the governor granted this step. */
  readonly outputTokenCap: number;
  readonly model: string;
  readonly tier: Tier;
  readonly spend: Spend;
}

/** The outcome of a whole governed run, including the partial-result handoff. */
export interface RunResult<T = unknown> {
  readonly runId: string;
  readonly reason: StopReason;
  readonly spend: Spend;
  readonly budgetUsd: number;
  readonly steps: readonly StepResult[];
  /** Steps that were planned but never started, because the money ran out. */
  readonly skipped: readonly string[];
  /**
   * Whether total spend exceeded the budget, and by how much.
   *
   * Zero for every provider that honours `max_tokens`. Non-zero only when a
   * provider overran its granted allowance and the kill-switch caught it after the
   * offending chunk had already arrived (and so had already been billed). Reported
   * rather than hidden: a governor that silently clamped its own books would be
   * lying about the one number it exists to control.
   */
  readonly overshootUsd: number;
  /**
   * Whatever the task managed to assemble from the steps that *did* run.
   * Populated on every stop reason, which is the point of a clean handoff:
   * a killed run returns the work it paid for, not an exception.
   */
  readonly partial: T;
}
