import type { ModelPricing, Tier } from "./types.ts";

/**
 * Published list prices, USD per million tokens, as of 2026-10-11.
 *
 * These are *configuration*, not measurements. The governor's arithmetic is only as
 * accurate as this table, so it lives in one place with a dated comment rather than
 * being scattered through the code. `scripts/check-pricing.md` documents how to
 * re-verify it against the vendor's pricing page.
 */
export const CATALOG: Readonly<Record<Tier, ModelPricing>> = {
  cheap: {
    id: "claude-haiku-4-5",
    tier: "cheap",
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
    maxOutputTokens: 1024,
  },
  mid: {
    id: "claude-sonnet-4-5",
    tier: "mid",
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    maxOutputTokens: 2048,
  },
  strong: {
    id: "claude-opus-4-1",
    tier: "strong",
    inputPerMTok: 15.0,
    outputPerMTok: 75.0,
    maxOutputTokens: 4096,
  },
};

/** USD cost of a given token count at a given model's prices. */
export function priceOf(pricing: ModelPricing, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMTok +
    (outputTokens / 1_000_000) * pricing.outputPerMTok
  );
}

/**
 * The largest USD amount a single step on this model could possibly cost, given a
 * granted output-token allowance.
 *
 * Deliberately pessimistic: it assumes the model emits the whole allowance. The
 * pre-flight gate compares *this* against the remaining budget, so a step is only
 * started when even its worst case fits.
 */
export function worstCaseUsd(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number = pricing.maxOutputTokens,
): number {
  return priceOf(pricing, inputTokens, outputTokens);
}

/**
 * The most output tokens this model may emit without the step's total cost
 * exceeding `remainingUsd`, given its already-known input size.
 *
 * This is the function that turns a monitored budget into an enforced one. Rather
 * than starting a stream and hoping to stop it in time, the governor solves for the
 * output allowance the remaining money can actually buy and hands that number to
 * the provider as `max_tokens`. A provider honouring it *cannot* emit enough tokens
 * to breach the cap, so the kill-switch becomes a second line of defence against a
 * misbehaving provider rather than the only thing standing between the run and an
 * overspend.
 *
 * Returns 0 when the input alone already costs more than the budget has left, and
 * is floored (never rounded up) so arithmetic error can only ever favour the budget.
 */
export function affordableOutputTokens(
  pricing: ModelPricing,
  inputTokens: number,
  remainingUsd: number,
): number {
  const inputUsd = priceOf(pricing, inputTokens, 0);
  const left = remainingUsd - inputUsd;
  if (left <= 0) return 0;
  const perToken = pricing.outputPerMTok / 1_000_000;
  if (perToken <= 0) return pricing.maxOutputTokens;
  return Math.min(pricing.maxOutputTokens, Math.floor(left / perToken));
}

/**
 * Character-count token estimate, used only for *pre-flight* input sizing.
 *
 * This is an approximation (~4 chars/token for English prose) and is documented as
 * such in the README's limitations section. It is never used to value spend: the
 * ledger always prefers provider-reported usage, and the estimator exists so the
 * pre-flight gate has a number to work with before the provider has said anything.
 * It rounds up, so it errs toward refusing a step rather than overspending.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
