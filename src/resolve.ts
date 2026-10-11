import { CATALOG } from "./pricing.ts";
import { AnthropicClient } from "./providers/anthropic.ts";
import { SimulatedClient } from "./providers/simulated.ts";
import type { ModelResolver, Tier } from "./types.ts";

/**
 * Chooses between the real provider and the deterministic simulator.
 *
 * `npm run keeper` works with no credentials: without `ANTHROPIC_API_KEY` the
 * resolver returns `SimulatedClient`, so the governor, the router, the kill-switch
 * and the dashboard are all exercisable (and demonstrable to a reader) offline. The
 * mode is returned alongside the resolver so every surface can label which one
 * produced its numbers — a cost figure from the simulator must never be presentable
 * as a real spend.
 */
export type RunMode = "live" | "simulated";

export interface Resolved {
  readonly mode: RunMode;
  readonly resolve: ModelResolver;
}

/**
 * Canned responses, long enough that the governor's affordable allowance — not the
 * length of the canned text — is always what determines where a run stops. A short
 * canned response would make every simulated run "complete" regardless of budget,
 * hiding the mechanism the demo exists to show.
 */
const SIMULATED_CHUNKS: Record<Tier, string[]> = {
  cheap: Array.from({ length: 2000 }, (_, i) => `cheap-tier token block ${i + 1}. `),
  mid: Array.from({ length: 2000 }, (_, i) => `mid-tier reasoning block ${i + 1}. `),
  strong: Array.from({ length: 2000 }, (_, i) => `strong-tier analysis block ${i + 1}. `),
};

export function resolveModels(apiKey: string | undefined): Resolved {
  if (apiKey) {
    return {
      mode: "live",
      resolve: (tier) => new AnthropicClient(CATALOG[tier], apiKey),
    };
  }
  return {
    mode: "simulated",
    resolve: (tier) =>
      new SimulatedClient(CATALOG[tier], [{ chunks: SIMULATED_CHUNKS[tier], inputTokens: 0 }]),
  };
}
