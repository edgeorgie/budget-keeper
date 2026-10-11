import type { ModelClient, ModelPricing, StreamChunk, StreamRequest } from "../types.ts";

/**
 * Anthropic Messages API client, streaming, with real usage accounting.
 *
 * Usage arrives in two places in Anthropic's SSE stream: `message_start` carries
 * `usage.input_tokens`, and `message_delta` carries cumulative `usage.output_tokens`.
 * Crucially, *neither* arrives per text chunk — so between the first token and the
 * final `message_delta` a naive meter reads zero while the money is being spent.
 * This client therefore emits text chunks with no usage (letting `Ledger` estimate
 * them) and converts the final cumulative `output_tokens` into a reconciliation
 * delta, so the meter is live throughout and exact at the end.
 */
export class AnthropicClient implements ModelClient {
  readonly pricing: ModelPricing;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  // Explicit fields rather than parameter properties: see the note in `ledger.ts`
  // — the source must stay loadable under Node's strip-only type erasure.
  constructor(pricing: ModelPricing, apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.pricing = pricing;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.pricing.id,
        // The governor's affordable allowance, not the model's own maximum: this is
        // what makes the provider itself enforce the budget.
        max_tokens: Math.max(1, Math.min(request.maxOutputTokens, this.pricing.maxOutputTokens)),
        stream: true,
        messages: [{ role: "user", content: request.prompt }],
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`anthropic ${response.status}: ${await response.text()}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let reportedOutput = 0;

    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let event: AnthropicEvent;
        try {
          event = JSON.parse(payload) as AnthropicEvent;
        } catch {
          continue;
        }

        if (event.type === "message_start" && event.message?.usage?.input_tokens != null) {
          yield { text: "", usage: { inputTokens: event.message.usage.input_tokens } };
        } else if (event.type === "content_block_delta" && event.delta?.text) {
          // No usage attached on purpose: the Ledger estimates it so the
          // kill-switch has a live number, and `message_delta` reconciles later.
          yield { text: event.delta.text };
        } else if (event.type === "message_delta" && event.usage?.output_tokens != null) {
          const delta = event.usage.output_tokens - reportedOutput;
          reportedOutput = event.usage.output_tokens;
          if (delta > 0) yield { text: "", usage: { outputTokens: delta } };
        }
      }
    }
  }
}

interface AnthropicEvent {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  delta?: { text?: string };
  usage?: { output_tokens?: number };
}
