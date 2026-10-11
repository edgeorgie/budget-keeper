import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.ts";
import {
  affordableOutputTokens,
  CATALOG,
  estimateTokens,
  priceOf,
  worstCaseUsd,
} from "../src/pricing.ts";
import { chooseTier, DEFAULT_ROUTER } from "../src/router.ts";
import { TIER_ORDER, type Tier } from "../src/types.ts";

describe("pricing arithmetic", () => {
  it("prices against an independently computed reference", () => {
    // Reference computed by hand from the catalog: Sonnet at $3/$15 per MTok.
    // 1,000 in → 1000/1e6 × 3 = 0.003; 500 out → 500/1e6 × 15 = 0.0075.
    expect(priceOf(CATALOG.mid, 1_000, 500)).toBeCloseTo(0.0105, 12);
    expect(priceOf(CATALOG.cheap, 0, 0)).toBe(0);
  });

  it("worst case assumes the model's full output allowance by default", () => {
    const expected = priceOf(CATALOG.strong, 100, CATALOG.strong.maxOutputTokens);
    expect(worstCaseUsd(CATALOG.strong, 100)).toBeCloseTo(expected, 12);
    // Must dominate any real outcome for the same input, which is the whole basis
    // of the pre-flight gate being sound.
    for (const out of [0, 1, 500, CATALOG.strong.maxOutputTokens]) {
      expect(worstCaseUsd(CATALOG.strong, 100)).toBeGreaterThanOrEqual(
        priceOf(CATALOG.strong, 100, out),
      );
    }
  });

  it("prices a worst case against an explicitly granted allowance", () => {
    expect(worstCaseUsd(CATALOG.mid, 1_000, 500)).toBeCloseTo(priceOf(CATALOG.mid, 1_000, 500), 12);
  });

  describe("affordableOutputTokens", () => {
    it("solves for an allowance whose full cost fits the budget", () => {
      const budget = 0.01;
      const allowance = affordableOutputTokens(CATALOG.mid, 500, budget);
      expect(allowance).toBeGreaterThan(0);
      expect(priceOf(CATALOG.mid, 500, allowance)).toBeLessThanOrEqual(budget);
      // Tight: one more token must breach, or the governor is under-spending.
      expect(priceOf(CATALOG.mid, 500, allowance + 1)).toBeGreaterThan(budget);
    });

    it("never exceeds the model's own output maximum", () => {
      expect(affordableOutputTokens(CATALOG.cheap, 0, 1_000_000)).toBe(
        CATALOG.cheap.maxOutputTokens,
      );
    });

    it("returns zero when the input alone exhausts the budget", () => {
      const inputOnly = priceOf(CATALOG.strong, 10_000, 0);
      expect(affordableOutputTokens(CATALOG.strong, 10_000, inputOnly)).toBe(0);
      expect(affordableOutputTokens(CATALOG.strong, 10_000, inputOnly / 2)).toBe(0);
      expect(affordableOutputTokens(CATALOG.strong, 10, 0)).toBe(0);
    });

    it("holds the fits-in-budget invariant across a wide sweep", () => {
      for (const tier of TIER_ORDER) {
        for (const inputTokens of [0, 10, 500, 20_000]) {
          for (const exponent of [-7, -6, -5, -4, -3, -2, -1, 0]) {
            const budget = 10 ** exponent;
            const allowance = affordableOutputTokens(CATALOG[tier], inputTokens, budget);
            if (allowance === 0) continue;
            expect(
              priceOf(CATALOG[tier], inputTokens, allowance),
              `${tier} in=${inputTokens} budget=${budget} allowance=${allowance}`,
            ).toBeLessThanOrEqual(budget);
          }
        }
      }
    });
  });

  it("estimates tokens by rounding up, never down", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("keeps the catalog tier-ordered by price, which the router assumes", () => {
    const prices = TIER_ORDER.map((t) => CATALOG[t].outputPerMTok);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    for (const tier of TIER_ORDER) {
      expect(CATALOG[tier].tier).toBe(tier);
    }
  });
});

describe("ledger", () => {
  it("prefers provider-reported usage over its own estimate", () => {
    const ledger = new Ledger(CATALOG.cheap);
    ledger.observe({ text: "", usage: { inputTokens: 100 } });
    ledger.observe({ text: "", usage: { outputTokens: 40 } });
    expect(ledger.isEstimated).toBe(false);
    expect(ledger.spend()).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      usd: priceOf(CATALOG.cheap, 100, 40),
    });
  });

  it("estimates output from chunk text when the provider reports nothing", () => {
    const ledger = new Ledger(CATALOG.cheap);
    ledger.observe({ text: "a".repeat(400) });
    expect(ledger.isEstimated).toBe(true);
    // 400 chars ≈ 100 tokens. Non-zero is the point: a meter reading zero during a
    // stream is exactly the bug the estimator exists to prevent.
    expect(ledger.spend().outputTokens).toBe(100);
    expect(ledger.spend().usd).toBeGreaterThan(0);
  });

  it("reconciles estimates to an authoritative total without double counting", () => {
    const ledger = new Ledger(CATALOG.mid);
    ledger.observe({ text: "", usage: { outputTokens: 30 } }); // authoritative
    ledger.observe({ text: "b".repeat(400) }); // estimated 100
    expect(ledger.spend().outputTokens).toBe(130);

    // Provider's final cumulative count is 180: the 30 already reported stand,
    // the 100 estimated are replaced, total becomes 180 and not 310.
    ledger.reconcile(180);
    expect(ledger.spend().outputTokens).toBe(180);
    expect(ledger.isEstimated).toBe(false);
  });

  it("never lets reconciliation lower an authoritative count", () => {
    const ledger = new Ledger(CATALOG.mid);
    ledger.observe({ text: "", usage: { outputTokens: 200 } });
    ledger.reconcile(50);
    expect(ledger.spend().outputTokens).toBe(200);
  });

  it("does not mutate the chunk it is given", () => {
    const ledger = new Ledger(CATALOG.cheap);
    const chunk = Object.freeze({ text: "hello", usage: Object.freeze({ outputTokens: 2 }) });
    expect(() => ledger.observe(chunk)).not.toThrow();
    expect(chunk.usage.outputTokens).toBe(2);
  });
});

describe("tier router", () => {
  it("escalates a retry above the tier that already failed", () => {
    expect(chooseTier("cheap", { retryOf: "cheap" }).tier).toBe("mid");
    expect(chooseTier("cheap", { retryOf: "mid" }).tier).toBe("strong");
  });

  it("does not escalate past the ceiling, and says so", () => {
    const decision = chooseTier("mid", { retryOf: "strong" });
    expect(decision.tier).toBe("strong");
    expect(decision.reason).toContain("ceiling");

    const capped = chooseTier("cheap", { confidence: 0.1 }, { ...DEFAULT_ROUTER, ceiling: "cheap" });
    expect(capped.tier).toBe("cheap");
  });

  it("escalates on long inputs regardless of a confident signal", () => {
    const decision = chooseTier("cheap", { confidence: 0.99, inputChars: 50_000 });
    expect(decision.tier).toBe("mid");
    expect(decision.reason).toContain("50000");
  });

  it("de-escalates only above the cheap-confidence threshold", () => {
    expect(chooseTier("mid", { confidence: 0.9 }).tier).toBe("cheap");
    expect(chooseTier("mid", { confidence: 0.84 }).tier).toBe("mid");
    expect(chooseTier("mid", { confidence: 0.59 }).tier).toBe("strong");
  });

  it("returns the declared tier with no signals, and always explains itself", () => {
    for (const tier of TIER_ORDER) {
      const decision = chooseTier(tier);
      expect(decision.tier).toBe(tier);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("only ever returns a tier from the catalog", () => {
    const inputs: Tier[] = ["cheap", "mid", "strong"];
    for (const declared of inputs) {
      for (const confidence of [0, 0.3, 0.6, 0.85, 1]) {
        const { tier } = chooseTier(declared, { confidence });
        expect(TIER_ORDER).toContain(tier);
        expect(CATALOG[tier]).toBeDefined();
      }
    }
  });
});
