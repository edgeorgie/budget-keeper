import type { RunResult, Spend, StepResult } from "./types.ts";

/**
 * Opt-in, anonymous run telemetry for the CLI.
 *
 * **Off unless the person running the CLI turns it on.** Both of these must be set,
 * and nothing is sent, written, printed or loaded otherwise:
 *
 *   BUDGET_KEEPER_TELEMETRY=1   the explicit opt-in (exactly `1`; nothing else counts)
 *   POSTHOG_KEY=<project token> where to send; there is deliberately no embedded token
 *
 * It sends one event, `run_completed`, when a run ends, describing the *shape* of the
 * run in buckets, counts and booleans. It never sends anything the run read, wrote or
 * was given: no repository name, dependency or advisory, no prompt or model output, no
 * file path, no command line, no environment variable and no credential. The payload
 * is built from the explicit allowlist in `runCompletedProperties`, never by spreading
 * or serialising a run object, so a field added to `RunResult` later cannot leak.
 *
 * It uses `fetch` against PostHog's capture endpoint instead of `posthog-node`: this
 * project's only runtime dependency is `semver`, and one fire-and-forget POST does not
 * justify a second. Every failure is swallowed; the request is bounded by
 * `TELEMETRY_TIMEOUT_MS`, which is therefore also the most telemetry can ever delay
 * the CLI's exit.
 *
 * The local dashboard (`src/dashboard`) deliberately does not import this module.
 */

export const TELEMETRY_EVENT = "run_completed";

/** PostHog Cloud US ingestion host. Override with `POSTHOG_HOST` (self-hosted, EU, proxy). */
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Single-event capture path, per PostHog's capture API reference. */
const CAPTURE_PATH = "/i/v0/e/";

/** Upper bound on how long telemetry may hold the process open at exit. */
export const TELEMETRY_TIMEOUT_MS = 2000;

/** The slice of `process.env` this module reads. */
export type TelemetryEnv = Readonly<Record<string, string | undefined>>;

/**
 * USD budget, bucketed so an exact figure is never sent. Lower edge inclusive:
 * `<0.05`, `0.05-0.25`, `0.25-1`, `1-10`, `10+`. The edges follow the tool's own
 * numbers: the CLI default is 0.05 and the dashboard's server-side ceiling is 0.25.
 */
export type BudgetBucket = "<0.05" | "0.05-0.25" | "0.25-1" | "1-10" | "10+";

export function budgetBucket(budgetUsd: number): BudgetBucket {
  if (budgetUsd < 0.05) return "<0.05";
  if (budgetUsd < 0.25) return "0.05-0.25";
  if (budgetUsd < 1) return "0.25-1";
  if (budgetUsd < 10) return "1-10";
  return "10+";
}

/**
 * The allowlist of `outcome` values: exactly `StopReason`, the closed union the
 * governor already declares. `satisfies Record<StopReason, true>` makes adding a
 * stop reason a compile error here until someone decides it is safe to report, and
 * the runtime lookup means a value outside the list is dropped, not forwarded.
 */
const OUTCOMES = {
  completed: true,
  "budget-preflight": true,
  "budget-exhausted": true,
  "budget-killswitch": true,
  "caller-abort": true,
  error: true,
} as const satisfies Record<RunResult["reason"], true>;

/** What `run_completed` carries. Every field is a bucket, a count, a boolean or a fixed string. */
export interface RunCompletedProperties {
  readonly app: "budget-keeper";
  readonly surface: "cli";
  /** PostHog: store the event without creating a person profile. */
  readonly $process_person_profile: false;
  /** PostHog: do not derive location from the sender's IP address. */
  readonly $geoip_disable: true;
  readonly budget_bucket: BudgetBucket;
  /** Spend as a whole percentage of the budget; above 100 only when a provider overran. */
  readonly spent_pct: number;
  /** Times a step ran on a different model tier than the step before it. */
  readonly tier_switches: number;
  /** True when the mid-stream kill-switch ended the run (`budget-killswitch`). */
  readonly killed: boolean;
  /** The run's stop reason; absent if it were ever outside the closed list. */
  readonly outcome?: RunResult["reason"];
}

/**
 * The only fields of a finished run this module reads. Typed narrowly on purpose: a
 * `RunResult` is accepted (it is a structural superset), but the signature says in
 * code that step text, the partial result and the model names are never consulted.
 */
export interface RunSummaryInput {
  readonly reason: RunResult["reason"];
  readonly budgetUsd: number;
  readonly spend: Pick<Spend, "usd">;
  readonly steps: readonly Pick<StepResult, "tier">[];
}

/** Builds the event properties, or `null` if the run has no usable budget to describe. */
export function runCompletedProperties(run: RunSummaryInput): RunCompletedProperties | null {
  const { budgetUsd } = run;
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return null;

  const pct = Math.round((run.spend.usd / budgetUsd) * 100);
  let tierSwitches = 0;
  for (let i = 1; i < run.steps.length; i++) {
    if (run.steps[i]?.tier !== run.steps[i - 1]?.tier) tierSwitches++;
  }

  return {
    app: "budget-keeper",
    surface: "cli",
    $process_person_profile: false,
    $geoip_disable: true,
    budget_bucket: budgetBucket(budgetUsd),
    spent_pct: Number.isFinite(pct) ? Math.max(0, pct) : 0,
    tier_switches: tierSwitches,
    killed: run.reason === "budget-killswitch",
    ...(Object.hasOwn(OUTCOMES, run.reason) ? { outcome: run.reason } : {}),
  };
}

export interface TelemetryTarget {
  /** Full capture URL. */
  readonly url: string;
  readonly key: string;
}

/**
 * Decides whether telemetry is on, and where it goes. `null` means off, and off is
 * the answer to every doubt: the opt-in must be exactly `1`; a key must be present
 * and must not be one of PostHog's secret kinds (`phx_` personal API keys and `phs_`
 * project secret keys, which must never be sent in an event body); and
 * `POSTHOG_HOST`, when set, must be a valid http(s) URL without embedded credentials.
 */
export function telemetryTarget(env: TelemetryEnv): TelemetryTarget | null {
  if (env["BUDGET_KEEPER_TELEMETRY"] !== "1") return null;

  const key = env["POSTHOG_KEY"]?.trim();
  if (!key || /^ph[xs]_/.test(key)) return null;

  let url: URL;
  try {
    url = new URL(env["POSTHOG_HOST"]?.trim() || DEFAULT_POSTHOG_HOST);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;

  // Append rather than resolve, so a host behind a path prefix (a reverse proxy at
  // https://example.com/ingest) keeps its prefix.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${CAPTURE_PATH}`;
  url.search = "";
  url.hash = "";
  return { url: url.toString(), key };
}

/**
 * Reports `run_completed` if, and only if, the environment opts in. Resolves when the
 * request has settled or timed out; **never rejects**, never writes to stdout or
 * stderr, and never touches the exit code. Callers should start it as soon as the run
 * finishes and `await` it just before exiting, so the request overlaps with the
 * work of rendering the report.
 *
 * `env` is a parameter rather than a read of `process.env` so tests (and the reader)
 * can see exactly what decides the outcome.
 */
export async function reportRunCompleted(
  run: RunSummaryInput,
  env: TelemetryEnv,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  try {
    const target = telemetryTarget(env);
    if (!target) return;
    const properties = runCompletedProperties(run);
    if (!properties) return;

    await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: target.key,
        event: TELEMETRY_EVENT,
        // A fresh random id per run: nothing links two runs, and nothing about the
        // machine or the person is hashed into it.
        distinct_id: crypto.randomUUID(),
        properties,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? TELEMETRY_TIMEOUT_MS),
    });
  } catch {
    // Network down, DNS failure, timeout, bad host, non-2xx: all are the same to the
    // caller, which is to say nothing happened.
  }
}
