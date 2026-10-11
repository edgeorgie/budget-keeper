import { describe, expect, it } from "vitest";
import { runGoverned, type Step } from "../src/governor.ts";
import { affordableOutputTokens, CATALOG, priceOf } from "../src/pricing.ts";
import { SimulatedClient } from "../src/providers/simulated.ts";
import type { GovernorEvent, ModelResolver, Tier } from "../src/types.ts";

/**
 * These tests assert the governor's load-bearing claims:
 *
 *   1. the USD ceiling is never exceeded, including across randomised run shapes;
 *   2. the budget is enforced by granting the provider an affordable output
 *      allowance, not merely by watching spend accumulate;
 *   3. the mid-stream kill-switch still stops a provider that ignores its allowance;
 *   4. a run stopped by the budget returns the work it paid for.
 *
 * Claim 1 is checked twice on purpose — once on a hand-computed case where the
 * arithmetic is readable, and once as a property over 200 pseudo-random
 * configurations, because a cap that holds for the README's example but not for an
 * arbitrary step/price/budget combination is not a cap.
 */

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resolverFor(chunks: string[], ignoreAllowance = false): ModelResolver {
  return (tier) =>
    new SimulatedClient(CATALOG[tier], [{ chunks, inputTokens: 0, ignoreAllowance }]);
}

function textSteps(count: number, tier: Tier = "cheap"): Step<string[]>[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `step-${i}`,
    tier,
    prompt: () => `prompt body for step ${i}`,
    apply: (state, text) => [...state, text],
  }));
}

/** Long enough that no realistic allowance can consume it all. */
const LONG = Array.from({ length: 4000 }, () => "x".repeat(40));

describe("the budget ceiling is hard", () => {
  it("never exceeds the ceiling on a hand-computable case", async () => {
    // Haiku at $5/MTok output. A $0.001 budget buys 0.001/5e-6 = 200 output tokens
    // in total, minus a few tokens of input cost per step.
    const budgetUsd = 0.001;
    const result = await runGoverned({
      budgetUsd,
      resolve: resolverFor(LONG),
      steps: textSteps(5),
      initialState: [],
    });

    expect(result.spend.usd).toBeLessThanOrEqual(budgetUsd);
    // The money is genuinely used, not conservatively hoarded: a governor that
    // spends 2% of its budget and stops is as broken as one that overspends.
    expect(result.spend.usd).toBeGreaterThan(budgetUsd * 0.8);
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
  });

  it("holds as a property across 200 randomised run shapes", async () => {
    const rnd = mulberry32(0xbadca5e);
    const tiers: Tier[] = ["cheap", "mid", "strong"];

    for (let trial = 0; trial < 200; trial++) {
      const chunkCount = 1 + Math.floor(rnd() * 600);
      const chunkSize = 1 + Math.floor(rnd() * 200);
      const stepCount = 1 + Math.floor(rnd() * 8);
      const tier = tiers[Math.floor(rnd() * tiers.length)] ?? "cheap";
      // Budgets spanning four orders of magnitude, including ones too small for
      // even the first step (which must then spend exactly nothing).
      const budgetUsd = 10 ** (-7 + rnd() * 4);

      const chunks = Array.from({ length: chunkCount }, () => "y".repeat(chunkSize));
      const result = await runGoverned({
        budgetUsd,
        resolve: resolverFor(chunks),
        steps: textSteps(stepCount, tier),
        initialState: [],
      });

      expect(
        result.spend.usd,
        `trial ${trial}: spent ${result.spend.usd} > budget ${budgetUsd} ` +
          `(tier=${tier} steps=${stepCount} chunks=${chunkCount}x${chunkSize})`,
      ).toBeLessThanOrEqual(budgetUsd);
    }
  });

  it("bounds a runaway provider's overshoot to a single chunk", async () => {
    const rnd = mulberry32(0x5eed1);
    let killSwitchFirings = 0;

    for (let trial = 0; trial < 50; trial++) {
      // Chunks sized so the 4000-chunk stream always costs far more than the
      // largest budget below (min 10 tok/chunk × 4000 = 40k tokens, vs. a ~4.1k
      // token ceiling at the strong tier's price). Without this floor, small
      // chunks let the stream finish naturally inside budget and the trial never
      // reaches the kill-switch at all.
      const chunkChars = 40 + Math.floor(rnd() * 120);
      const chunks = Array.from({ length: 4000 }, () => "z".repeat(chunkChars));
      // Budgets chosen to genuinely FUND at least one strong-tier step — a budget
      // small enough to be refused pre-flight would make this test vacuous,
      // passing even with the kill-switch deleted. The assertion below on
      // `killSwitchFirings` is what keeps that from silently regressing.
      const budgetUsd = 0.01 + rnd() * 0.3;

      const result = await runGoverned({
        budgetUsd,
        // A provider that streams forever regardless of max_tokens.
        resolve: resolverFor(chunks, true),
        steps: textSteps(3, "strong"),
        initialState: [],
      });

      if (result.reason === "budget-killswitch") killSwitchFirings += 1;

      // The honest guarantee: a chunk's cost is only knowable once it has arrived
      // (and been billed), so the overshoot is bounded by one chunk per step that
      // ran — never unbounded, and never silently hidden.
      const oneChunkUsd = priceOf(CATALOG.strong, 0, Math.ceil(chunkChars / 4));
      expect(
        result.overshootUsd,
        `trial ${trial}: overshoot ${result.overshootUsd} exceeded one chunk ${oneChunkUsd}`,
      ).toBeLessThanOrEqual(oneChunkUsd * Math.max(1, result.steps.length) + 1e-12);
    }

    // Guards against the whole block passing vacuously: if trials never reached
    // the kill-switch, the bound above was never actually exercised. Not all 50
    // need to fire — at the top of the budget range the model's own
    // `maxOutputTokens` cap ends the stream before the money does, which is a
    // legitimate path — but the overwhelming majority must.
    expect(killSwitchFirings).toBeGreaterThanOrEqual(45);
  });

  it("reports zero overshoot for any provider that honours its allowance", async () => {
    const rnd = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 50; trial++) {
      const budgetUsd = 10 ** (-6 + rnd() * 3);
      const chunks = Array.from({ length: 2000 }, () => "z".repeat(1 + Math.floor(rnd() * 120)));
      const result = await runGoverned({
        budgetUsd,
        resolve: resolverFor(chunks),
        steps: textSteps(3, "strong"),
        initialState: [],
      });
      expect(result.overshootUsd, `trial ${trial}`).toBe(0);
      expect(result.spend.usd).toBeLessThanOrEqual(budgetUsd);
    }
  });

  it("distinguishes spending the budget down from a provider overrun", async () => {
    // A well-behaved provider: the budget is consumed by steps that each stay
    // inside their allowance, so the run ends on a budget gate with no
    // kill-switch event at all. (The usual terminal state is
    // `budget-preflight` rather than `budget-exhausted`: flooring the allowance
    // leaves a sliver of money too small to fund another step, so the next
    // step's gate refuses it before the balance reaches exactly zero.)
    const wellBehaved: GovernorEvent[] = [];
    const honest = await runGoverned({
      budgetUsd: 0.05,
      resolve: resolverFor(LONG),
      steps: textSteps(4, "mid"),
      initialState: [],
      onEvent: (e) => wellBehaved.push(e),
    });

    expect(["budget-preflight", "budget-exhausted"]).toContain(honest.reason);
    expect(honest.overshootUsd).toBe(0);
    expect(wellBehaved.some((e) => e.type === "killswitch")).toBe(false);
    expect(wellBehaved.some((e) => e.type === "allowance-exhausted")).toBe(true);

    // Spending the budget down to EXACTLY the ceiling is the governor working
    // perfectly, not an overrun — a `killswitch` event here would cry wolf on
    // every well-behaved run that uses its full budget.
    const exact: GovernorEvent[] = [];
    const landed = await runGoverned({
      budgetUsd: 0.12,
      resolve: resolverFor(LONG),
      steps: textSteps(1, "strong"),
      initialState: [],
      onEvent: (e) => exact.push(e),
    });
    expect(landed.overshootUsd).toBe(0);
    expect(exact.some((e) => e.type === "killswitch")).toBe(false);

    // A misbehaving provider that ignores its allowance. The token guard catches
    // it on the first chunk that crosses the line, so the overshoot is bounded by
    // that one chunk's size — and with large chunks it is genuinely non-zero and
    // reported rather than hidden. (With small chunks the guard lands exactly on
    // the boundary and overshoot is 0, which is why this case uses 400-char
    // chunks: the point is that the overshoot is *bounded and visible*, not that
    // it is always zero.)
    const runaway: GovernorEvent[] = [];
    const bigChunks = Array.from({ length: 4000 }, () => "x".repeat(400));
    const breached = await runGoverned({
      budgetUsd: 0.05,
      resolve: resolverFor(bigChunks, true),
      steps: textSteps(4, "mid"),
      initialState: [],
      onEvent: (e) => runaway.push(e),
    });

    // Bounded by one chunk (400 chars ≈ 100 tokens) per step that ran, never more.
    const oneChunkUsd = priceOf(CATALOG.mid, 0, 100);
    expect(breached.overshootUsd).toBeLessThanOrEqual(
      oneChunkUsd * Math.max(1, breached.steps.length) + 1e-12,
    );
    // And the governor still stops: it does not stream the full 4000 chunks.
    expect(breached.steps.every((s) => s.truncated)).toBe(true);
  });

  it("spends exactly nothing when the budget cannot fund a useful step", async () => {
    const client = new SimulatedClient(CATALOG.strong, [{ chunks: ["a"], inputTokens: 0 }]);
    const result = await runGoverned({
      budgetUsd: 1e-9,
      resolve: () => client,
      steps: textSteps(3, "strong"),
      initialState: [],
    });

    expect(result.reason).toBe("budget-preflight");
    expect(result.spend.usd).toBe(0);
    expect(result.steps).toHaveLength(0);
    // The decisive assertion: the model was never called, so no provider-side
    // tokens were spent either. A post-hoc cost check could not prove this.
    expect(client.callCount).toBe(0);
    expect(result.skipped).toEqual(["step-0", "step-1", "step-2"]);
  });

  it("refuses a step it could technically start but not usefully fund", async () => {
    // Budget sized to afford ~10 output tokens: above zero, below minOutputTokens.
    const inputTokens = Math.ceil("prompt body for step 0".length / 4);
    const budgetUsd = priceOf(CATALOG.cheap, inputTokens, 10);
    const client = new SimulatedClient(CATALOG.cheap, [{ chunks: LONG, inputTokens: 0 }]);

    const result = await runGoverned({
      budgetUsd,
      resolve: () => client,
      steps: textSteps(1),
      initialState: [],
      minOutputTokens: 48,
    });

    expect(result.reason).toBe("budget-preflight");
    expect(client.callCount).toBe(0);
    expect(result.spend.usd).toBe(0);
  });
});

describe("the provider-side allowance", () => {
  it("grants an allowance equal to what the remaining budget can buy", async () => {
    const client = new SimulatedClient(CATALOG.mid, [{ chunks: LONG, inputTokens: 0 }]);
    const budgetUsd = 0.004;
    const inputTokens = Math.ceil("prompt body for step 0".length / 4);

    await runGoverned({
      budgetUsd,
      resolve: () => client,
      steps: textSteps(1, "mid"),
      initialState: [],
    });

    expect(client.lastAllowance).toBe(affordableOutputTokens(CATALOG.mid, inputTokens, budgetUsd));
    // Sanity: that allowance priced out is within budget, which is the invariant
    // the whole mechanism rests on.
    expect(priceOf(CATALOG.mid, inputTokens, client.lastAllowance ?? 0)).toBeLessThanOrEqual(budgetUsd);
  });

  it("shrinks the allowance for later steps as money is consumed", async () => {
    const allowances: number[] = [];
    const result = await runGoverned({
      budgetUsd: 0.01,
      resolve: () => new SimulatedClient(CATALOG.cheap, [{ chunks: LONG, inputTokens: 0 }]),
      steps: textSteps(4),
      initialState: [],
      onEvent: (e) => {
        if (e.type === "step-start") allowances.push(e.outputTokenCap);
      },
    });

    expect(allowances.length).toBeGreaterThan(1);
    expect([...allowances].sort((a, b) => b - a)).toEqual(allowances);
    expect(result.spend.usd).toBeLessThanOrEqual(0.01);
  });

  it("caps the allowance at the model's own maximum on a generous budget", async () => {
    const client = new SimulatedClient(CATALOG.cheap, [{ chunks: LONG, inputTokens: 0 }]);
    await runGoverned({
      budgetUsd: 1_000,
      resolve: () => client,
      steps: textSteps(1),
      initialState: [],
    });
    expect(client.lastAllowance).toBe(CATALOG.cheap.maxOutputTokens);
  });
});

describe("the kill-switch fires mid-stream, not after it", () => {
  it("aborts a runaway stream and keeps the partial text", async () => {
    const seen: number[] = [];
    const chunks = Array.from({ length: 5000 }, () => "z".repeat(100));
    const client = new SimulatedClient(CATALOG.mid, [
      { chunks, inputTokens: 0, ignoreAllowance: true, onChunk: (i) => seen.push(i) },
    ]);

    const result = await runGoverned({
      budgetUsd: 0.002,
      resolve: () => client,
      steps: textSteps(1, "mid"),
      initialState: [],
    });

    // The stream was cut long before its last chunk: proof the governor acted
    // during the stream rather than letting it drain and reporting the overage.
    expect(seen.length).toBeLessThan(chunks.length);
    expect(result.steps[0]?.truncated).toBe(true);
    expect(result.steps[0]?.text.length).toBeGreaterThan(0);
    // Overshoot is at most the one chunk that had already arrived when the
    // ledger crossed the line, and it is reported rather than concealed.
    expect(result.overshootUsd).toBeLessThanOrEqual(priceOf(CATALOG.mid, 0, 25) + 1e-12);
  });

  it("hands back the partial result instead of throwing", async () => {
    const result = await runGoverned({
      budgetUsd: 0.0008,
      resolve: resolverFor(LONG),
      steps: textSteps(4),
      initialState: [],
    });

    expect(result.reason).not.toBe("completed");
    expect(result.reason).not.toBe("error");
    // `partial` carries the state every completed step folded in, including any
    // truncated one — a governed run must not lose work it already paid for.
    expect(result.partial.length).toBe(result.steps.length);
    expect(result.partial.join("").length).toBeGreaterThan(0);
    expect(result.skipped.length).toBe(4 - result.steps.length);
  });

  it("reports a step that threw as an error, keeping prior steps' work", async () => {
    const resolve: ModelResolver = (tier) => ({
      pricing: CATALOG[tier],
      async *stream(): AsyncIterable<never> {
        throw new Error("provider exploded");
      },
    });

    const result = await runGoverned({
      budgetUsd: 1,
      resolve,
      steps: textSteps(3),
      initialState: [],
    });

    expect(result.reason).toBe("error");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.truncated).toBe(true);
    expect(result.skipped).toEqual(["step-1", "step-2"]);
  });
});

describe("event stream", () => {
  it("reports live spend per chunk and a terminal run-end exactly once", async () => {
    const events: GovernorEvent[] = [];
    const chunks = Array.from({ length: 12 }, () => "q".repeat(40));

    await runGoverned({
      budgetUsd: 1,
      resolve: resolverFor(chunks),
      steps: textSteps(2),
      initialState: [],
      onEvent: (e) => events.push(e),
    });

    const spends = events.filter((e) => e.type === "spend");
    // 12 text chunks + 1 input-usage frame per step, 2 steps.
    expect(spends.length).toBe(26);
    // Monotonically non-decreasing within a step is what makes the gauge honest.
    const usds = spends
      .filter((e) => e.type === "spend" && e.step === 0)
      .map((e) => (e.type === "spend" ? e.spend.usd : 0));
    expect([...usds].sort((a, b) => a - b)).toEqual(usds);
    expect(events.filter((e) => e.type === "run-end")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run-end");
  });

  it("explains every tier decision it makes", async () => {
    const events: GovernorEvent[] = [];
    await runGoverned({
      budgetUsd: 1,
      resolve: resolverFor(["short"]),
      steps: textSteps(3),
      initialState: [],
      onEvent: (e) => events.push(e),
    });
    const decisions = events.filter((e) => e.type === "tier-decision");
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) {
      if (decision.type === "tier-decision") expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("caller abort", () => {
  it("stops between steps and reports caller-abort", async () => {
    const controller = new AbortController();
    const result = await runGoverned({
      budgetUsd: 1,
      resolve: resolverFor(["a".repeat(20)]),
      steps: textSteps(4),
      initialState: [],
      onEvent: (e) => {
        if (e.type === "step-end" && e.step === 1) controller.abort();
      },
      signal: controller.signal,
    });

    expect(result.reason).toBe("caller-abort");
    expect(result.steps).toHaveLength(2);
    expect(result.skipped).toEqual(["step-2", "step-3"]);
  });

  it("does not start any step when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new SimulatedClient(CATALOG.cheap, [{ chunks: ["a"], inputTokens: 0 }]);
    const result = await runGoverned({
      budgetUsd: 1,
      resolve: () => client,
      steps: textSteps(2),
      initialState: [],
      signal: controller.signal,
    });
    expect(result.reason).toBe("caller-abort");
    expect(client.callCount).toBe(0);
    expect(result.spend.usd).toBe(0);
  });
});
