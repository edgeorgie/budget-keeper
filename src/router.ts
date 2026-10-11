import { TIER_ORDER, type Tier } from "./types.ts";

/**
 * Signals a step can offer the router about how hard it expects to be.
 * All are optional: a step that knows nothing gets the default tier.
 */
export interface Complexity {
  /**
   * The step's own confidence, 0..1, that a cheap model can do the job.
   * Typically produced by the previous step (e.g. a classifier that says
   * "this advisory is a straightforward version bump" with 0.9 confidence).
   */
  readonly confidence?: number;
  /** Rough size of the input the step must reason over, in characters. */
  readonly inputChars?: number;
  /** Set when a cheaper attempt already failed and is being retried. */
  readonly retryOf?: Tier;
}

export interface RouterConfig {
  /** Below this confidence, escalate one tier. Default 0.6. */
  readonly escalateBelowConfidence: number;
  /** Above this confidence, allow the cheapest tier. Default 0.85. */
  readonly cheapAboveConfidence: number;
  /** Inputs larger than this escalate regardless of confidence. Default 24_000 chars. */
  readonly escalateAboveChars: number;
  /** Never exceed this tier, whatever the heuristic says. Default "strong". */
  readonly ceiling: Tier;
}

export const DEFAULT_ROUTER: RouterConfig = {
  escalateBelowConfidence: 0.6,
  cheapAboveConfidence: 0.85,
  escalateAboveChars: 24_000,
  ceiling: "strong",
};

export interface TierDecision {
  readonly tier: Tier;
  /** Human-readable justification, surfaced in the event stream and the CLI. */
  readonly reason: string;
}

function bump(tier: Tier, by: number, ceiling: Tier): Tier {
  const i = TIER_ORDER.indexOf(tier);
  const max = TIER_ORDER.indexOf(ceiling);
  const next = Math.min(Math.max(i + by, 0), max);
  // `TIER_ORDER` is non-empty and `next` is clamped into it, so this is total.
  return TIER_ORDER[next] ?? tier;
}

/**
 * Picks a model tier for a step from a declared default plus observed complexity.
 *
 * The rules, in precedence order:
 *
 * 1. A retry of a tier that already failed escalates one tier. Retrying the same
 *    tier that just failed is the single most common way an agent burns budget for
 *    nothing, so it is ruled out structurally rather than by prompt discipline.
 * 2. A very large input escalates, because long-context reasoning is where cheap
 *    models degrade most visibly, and because a long input is already expensive —
 *    paying twice for a cheap failure costs more than going up once.
 * 3. Low confidence escalates; high confidence de-escalates to the floor.
 * 4. Otherwise the step's declared default stands.
 *
 * Every branch returns a `reason`: a routing decision nobody can explain after the
 * fact is indistinguishable from a bug.
 */
export function chooseTier(
  declared: Tier,
  complexity: Complexity = {},
  config: RouterConfig = DEFAULT_ROUTER,
): TierDecision {
  const { ceiling } = config;

  if (complexity.retryOf) {
    const tier = bump(complexity.retryOf, 1, ceiling);
    return tier === complexity.retryOf
      ? { tier, reason: `retry of failed ${complexity.retryOf}, already at ceiling ${ceiling}` }
      : { tier, reason: `escalated from ${complexity.retryOf} after a failed attempt` };
  }

  if ((complexity.inputChars ?? 0) > config.escalateAboveChars) {
    const tier = bump(declared, 1, ceiling);
    return {
      tier,
      reason: `input of ${complexity.inputChars} chars exceeds ${config.escalateAboveChars}`,
    };
  }

  const confidence = complexity.confidence;
  if (confidence != null) {
    if (confidence < config.escalateBelowConfidence) {
      return {
        tier: bump(declared, 1, ceiling),
        reason: `confidence ${confidence.toFixed(2)} below ${config.escalateBelowConfidence}`,
      };
    }
    if (confidence >= config.cheapAboveConfidence) {
      return {
        tier: bump(declared, -1, ceiling),
        reason: `confidence ${confidence.toFixed(2)} at or above ${config.cheapAboveConfidence}`,
      };
    }
  }

  return { tier: bump(declared, 0, ceiling), reason: "declared default, no escalation signal" };
}
