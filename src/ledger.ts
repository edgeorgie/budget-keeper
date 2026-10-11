import { estimateTokens, priceOf } from "./pricing.ts";
import type { ModelPricing, Spend, StreamChunk, UsageDelta } from "./types.ts";

/**
 * Accumulates token usage for one step and values it in USD continuously.
 *
 * Two things make this a *meter* rather than a cost report:
 *
 * 1. It is fed per-chunk while the stream is still open, so `spend()` is a live
 *    number the kill-switch can test against on every chunk boundary.
 * 2. It degrades deterministically when a provider does not report usage per chunk.
 *    Most streaming APIs send input usage once up-front and output usage only in a
 *    final message — which would leave the meter reading zero for the entire window
 *    in which the money is actually being spent. So when a chunk carries no usage,
 *    the meter estimates output tokens from the chunk's own text and marks the step
 *    `estimated`. When a later chunk *does* report authoritative totals, the meter
 *    reconciles to them (see `reconcile`), discarding its estimate.
 *
 * The deliberate consequence: the number the kill-switch reads is never stale, and
 * when it is approximate it is approximate in the direction of stopping sooner.
 */
export class Ledger {
  private inputTokens = 0;
  private outputTokens = 0;
  /** Output tokens that came from the estimator rather than the provider. */
  private estimatedOutputTokens = 0;
  private readonly pricing: ModelPricing;

  // Explicit field assignment rather than a TypeScript parameter property:
  // Node's `--experimental-strip-types` erases types without transforming
  // syntax, so parameter properties fail at load time. Keeping the source
  // strip-compatible is what lets `npm run keeper` and `npm run dashboard` run
  // straight from source with no build step.
  constructor(pricing: ModelPricing) {
    this.pricing = pricing;
  }

  /** Record usage the provider reported explicitly. */
  add(delta: UsageDelta): void {
    this.inputTokens += delta.inputTokens ?? 0;
    this.outputTokens += delta.outputTokens ?? 0;
  }

  /**
   * Feed one streamed chunk. Prefers provider usage; estimates from text otherwise.
   * Returns the live spend so a caller can test the kill-switch in the same breath.
   */
  observe(chunk: StreamChunk): Spend {
    if (chunk.usage && (chunk.usage.inputTokens != null || chunk.usage.outputTokens != null)) {
      this.add(chunk.usage);
    } else if (chunk.text.length > 0) {
      const est = estimateTokens(chunk.text);
      this.outputTokens += est;
      this.estimatedOutputTokens += est;
    }
    return this.spend();
  }

  /**
   * Replace estimated output tokens with an authoritative total from the provider.
   *
   * Called when a provider sends a final cumulative usage message. Only the
   * estimated portion is replaced: tokens the provider already reported per-chunk
   * are authoritative and must not be double-counted.
   */
  reconcile(authoritativeOutputTokens: number): void {
    const reported = this.outputTokens - this.estimatedOutputTokens;
    this.outputTokens = Math.max(reported, authoritativeOutputTokens);
    this.estimatedOutputTokens = 0;
  }

  /** True when any part of the current valuation rests on the estimator. */
  get isEstimated(): boolean {
    return this.estimatedOutputTokens > 0;
  }

  spend(): Spend {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      usd: priceOf(this.pricing, this.inputTokens, this.outputTokens),
    };
  }
}

/** Sums per-step spends into a run total. Prices are already applied per step. */
export function sumSpend(parts: readonly Spend[]): Spend {
  return parts.reduce<Spend>(
    (acc, p) => ({
      inputTokens: acc.inputTokens + p.inputTokens,
      outputTokens: acc.outputTokens + p.outputTokens,
      usd: acc.usd + p.usd,
    }),
    { inputTokens: 0, outputTokens: 0, usd: 0 },
  );
}
