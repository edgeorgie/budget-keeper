import type { ModelClient, ModelPricing, StreamChunk, StreamRequest } from "../types.ts";

/**
 * A deterministic, offline `ModelClient` used by the test suite, by CI, and by
 * `npm run keeper` when no `ANTHROPIC_API_KEY` is present.
 *
 * It exists for one reason that matters beyond convenience: the properties this
 * project claims — "the cap is never exceeded", "a killed run returns its partial
 * work", "a retry escalates tier" — are properties of the *governor*, not of any
 * model. Asserting them against a live model would make the test suite
 * non-deterministic, slow, and expensive, and would make a red build ambiguous
 * between "the governor regressed" and "the vendor was slow today". So the governor
 * is tested against a client whose token emission is exactly specified, and the
 * real client is exercised separately (see README, "What is verified, and how").
 *
 * The emission shape deliberately mirrors `AnthropicClient`: input usage once
 * up-front, text chunks with no usage, and an optional final cumulative output
 * usage. A fake that reported usage on every chunk would hide exactly the bug the
 * `Ledger` estimator exists to prevent.
 */
export interface SimulatedResponse {
  /** Text chunks, emitted in order. */
  readonly chunks: readonly string[];
  /** Input usage reported once before any text, as a real provider does. */
  readonly inputTokens?: number;
  /** Final cumulative output usage. Omit to simulate a provider that never reports. */
  readonly finalOutputTokens?: number;
  /** Abort-check hook, so tests can assert the signal is honoured promptly. */
  readonly onChunk?: (index: number) => void;
  /**
   * When true, emit every chunk regardless of the `maxOutputTokens` allowance the
   * governor granted — a deliberately misbehaving provider. This exists so the
   * mid-stream kill-switch can be tested as the independent safety net it claims to
   * be, rather than being masked by the allowance mechanism always working.
   */
  readonly ignoreAllowance?: boolean;
}

export class SimulatedClient implements ModelClient {
  private call = 0;
  /** The allowance granted on the most recent call, for assertions. */
  lastAllowance: number | null = null;
  readonly pricing: ModelPricing;
  private readonly responses: readonly SimulatedResponse[];

  // Explicit fields rather than parameter properties: see the note in `ledger.ts`.
  constructor(pricing: ModelPricing, responses: readonly SimulatedResponse[]) {
    this.pricing = pricing;
    this.responses = responses;
  }

  /** Number of times `stream` has been invoked. Used by tests asserting refusals. */
  get callCount(): number {
    return this.call;
  }

  async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const response = this.responses[Math.min(this.call, this.responses.length - 1)];
    this.call += 1;
    this.lastAllowance = request.maxOutputTokens;
    if (!response) return;

    if (response.inputTokens != null) {
      yield { text: "", usage: { inputTokens: response.inputTokens } };
    }

    // A well-behaved provider stops at exactly its `max_tokens`, truncating
    // mid-text if need be — it does not overshoot by a whole chunk. The simulator
    // reproduces that faithfully, using the estimator's own ~4-chars-per-token
    // convention so the simulated provider and the Ledger agree on what a token is.
    // Being faithful here matters: a simulator that overshot by a chunk would make
    // the governor's own tests fail for a reason real providers never exhibit.
    let emitted = 0;
    for (const [index, text] of response.chunks.entries()) {
      if (signal.aborted) return;
      let piece = text;
      if (!response.ignoreAllowance) {
        const room = request.maxOutputTokens - emitted;
        if (room <= 0) return;
        const cost = Math.ceil(piece.length / 4);
        if (cost > room) piece = piece.slice(0, room * 4);
      }
      response.onChunk?.(index);
      emitted += Math.ceil(piece.length / 4);
      yield { text: piece };
    }

    if (!signal.aborted && response.finalOutputTokens != null) {
      yield { text: "", usage: { outputTokens: response.finalOutputTokens } };
    }
  }
}
