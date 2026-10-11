import { afterEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import { CATALOG } from "../src/pricing.ts";
import { AnthropicClient } from "../src/providers/anthropic.ts";
import type { StreamChunk } from "../src/types.ts";

/**
 * The real provider client is tested against a stubbed `fetch` that replays an
 * actual Anthropic SSE frame sequence. This is the piece most likely to silently
 * break the kill-switch: if the parser attached provider usage to text chunks, or
 * treated `message_delta`'s cumulative `output_tokens` as a delta, the meter would
 * read wrong *while a stream is open* — and every governor test would still pass,
 * because those use the simulator. So the frame handling is pinned here.
 */

const FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":37,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
  'event: ping\ndata: {"type":"ping"}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/** Splits the stream at arbitrary byte boundaries, as a real socket would. */
function bodyFrom(text: string, pieceSize: number): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < bytes.length; i += pieceSize) {
        yield bytes.slice(i, i + pieceSize);
      }
    },
  };
}

function stubFetch(text: string, pieceSize: number): void {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    body: bodyFrom(text, pieceSize),
    text: async () => "",
  }));
}

async function collect(pieceSize: number): Promise<StreamChunk[]> {
  stubFetch(FRAMES.join(""), pieceSize);
  const client = new AnthropicClient(CATALOG.cheap, "test-key-not-a-real-credential");
  const out: StreamChunk[] = [];
  for await (const chunk of client.stream({ prompt: "hi", maxOutputTokens: 1024 }, new AbortController().signal)) out.push(chunk);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic SSE parsing", () => {
  it("extracts input usage, text, and output usage in order", async () => {
    const chunks = await collect(4096);
    expect(chunks[0]).toEqual({ text: "", usage: { inputTokens: 37 } });
    expect(chunks.map((c) => c.text).join("")).toBe("Hello world");
    expect(chunks.at(-1)).toEqual({ text: "", usage: { outputTokens: 12 } });
  });

  it("attaches no usage to text chunks, so the Ledger meters them live", async () => {
    const chunks = await collect(4096);
    const textChunks = chunks.filter((c) => c.text.length > 0);
    expect(textChunks).toHaveLength(2);
    for (const chunk of textChunks) {
      expect(chunk.usage).toBeUndefined();
    }

    // The consequence that matters: spend is non-zero before the final usage
    // frame arrives, which is what lets the kill-switch act during the stream.
    const ledger = new Ledger(CATALOG.cheap);
    ledger.observe(chunks[0] as StreamChunk);
    ledger.observe(textChunks[0] as StreamChunk);
    expect(ledger.spend().usd).toBeGreaterThan(0);
    expect(ledger.isEstimated).toBe(true);
  });

  it("is robust to frames split across arbitrary byte boundaries", async () => {
    for (const pieceSize of [1, 3, 17, 64, 4096]) {
      const chunks = await collect(pieceSize);
      expect(
        chunks.map((c) => c.text).join(""),
        `text lost at pieceSize=${pieceSize}`,
      ).toBe("Hello world");
      expect(chunks.at(-1)?.usage?.outputTokens, `usage lost at pieceSize=${pieceSize}`).toBe(12);
      vi.unstubAllGlobals();
    }
  });

  it("ignores ping frames and unparseable data without aborting the stream", async () => {
    stubFetch(
      [FRAMES[0], "event: ping\ndata: {\n\n", 'data: not-json\n\n', FRAMES[2], FRAMES[5]].join(""),
      7,
    );
    const client = new AnthropicClient(CATALOG.cheap, "test-key-not-a-real-credential");
    const out: StreamChunk[] = [];
    for await (const chunk of client.stream({ prompt: "hi", maxOutputTokens: 1024 }, new AbortController().signal)) out.push(chunk);
    expect(out.map((c) => c.text).join("")).toBe("Hello");
  });

  it("converts cumulative output_tokens into deltas, never double counting", async () => {
    stubFetch(
      [
        FRAMES[0],
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
      ].join(""),
      512,
    );
    const client = new AnthropicClient(CATALOG.cheap, "test-key-not-a-real-credential");
    const ledger = new Ledger(CATALOG.cheap);
    for await (const chunk of client.stream({ prompt: "hi", maxOutputTokens: 1024 }, new AbortController().signal)) {
      ledger.observe(chunk);
    }
    // 5 then cumulative 9 must total 9, not 14.
    expect(ledger.spend().outputTokens).toBe(9);
  });

  it("passes the governor's allowance through as max_tokens, clamped to the model", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, status: 200, body: bodyFrom(FRAMES.join(""), 4096), text: async () => "" };
    });
    const client = new AnthropicClient(CATALOG.cheap, "test-key-not-a-real-credential");

    for await (const _ of client.stream({ prompt: "hi", maxOutputTokens: 97 }, new AbortController().signal)) void _;
    expect(JSON.parse(bodies[0] ?? "{}").max_tokens).toBe(97);

    // An allowance above the model's own maximum is clamped, and a zero/negative
    // one becomes 1 rather than an invalid request the provider would reject.
    for await (const _ of client.stream({ prompt: "hi", maxOutputTokens: 99_999 }, new AbortController().signal)) void _;
    expect(JSON.parse(bodies[1] ?? "{}").max_tokens).toBe(CATALOG.cheap.maxOutputTokens);

    for await (const _ of client.stream({ prompt: "hi", maxOutputTokens: 0 }, new AbortController().signal)) void _;
    expect(JSON.parse(bodies[2] ?? "{}").max_tokens).toBe(1);
  });

  it("throws with the provider's status on a non-OK response", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 429,
      body: null,
      text: async () => "rate limited",
    }));
    const client = new AnthropicClient(CATALOG.cheap, "test-key-not-a-real-credential");
    const iterate = async () => {
      for await (const _ of client.stream({ prompt: "hi", maxOutputTokens: 1024 }, new AbortController().signal)) void _;
    };
    await expect(iterate()).rejects.toThrow(/anthropic 429/);
  });
});
