import type { Step } from "../governor.ts";
import type { Exposure } from "./cve-scan.ts";

/** State threaded through the governed steps of a patch-plan run. */
export interface PlanState {
  readonly repo: string;
  readonly exposures: readonly Exposure[];
  /** One write-up per exposure, in priority order. Index i ↔ exposures[i]. */
  readonly writeups: readonly { ghsaId: string; text: string; truncated: boolean }[];
  readonly summary: string | null;
}

export function initialState(repo: string, exposures: readonly Exposure[]): PlanState {
  return { repo, exposures, writeups: [], summary: null };
}

function describe(exposure: Exposure): string {
  const { dependency: dep, advisory: adv } = exposure;
  return [
    `Package: ${dep.name}@${dep.range} (${dep.dev ? "devDependency" : "dependency"})`,
    `Resolved-low version: ${exposure.pinnedVersion}`,
    `Advisory: ${adv.ghsaId}${adv.cveId ? ` / ${adv.cveId}` : ""} (${adv.severity})`,
    `Summary: ${adv.summary}`,
    `Vulnerable range: ${adv.vulnerableRange}`,
    `First patched version: ${adv.firstPatchedVersion ?? "none published"}`,
    `Needs a semver-range bump: ${exposure.requiresRangeBump ? "yes" : "no"}`,
  ].join("\n");
}

/**
 * Severity-driven tier and confidence for one exposure.
 *
 * The heuristic is intentionally simple and stated in one place so it can be argued
 * with: a `critical`/`high` advisory that needs a range bump is where a wrong answer
 * costs the most (a human will act on it, possibly out of hours), so it goes to the
 * strongest tier. A `low`/`moderate` advisory with a drop-in patched version is a
 * mechanical write-up and is handed to the cheap tier with high confidence, which is
 * what the router needs to de-escalate.
 */
function signalsFor(exposure: Exposure): { tier: "cheap" | "mid" | "strong"; confidence: number } {
  const severe = exposure.advisory.severity === "critical" || exposure.advisory.severity === "high";
  if (severe && exposure.requiresRangeBump) return { tier: "strong", confidence: 0.4 };
  if (severe) return { tier: "mid", confidence: 0.55 };
  if (exposure.requiresRangeBump) return { tier: "mid", confidence: 0.7 };
  return { tier: "cheap", confidence: 0.9 };
}

/**
 * Builds one governed step per exposure, plus a final roll-up.
 *
 * Why one step per exposure instead of a single prompt listing all of them: the
 * budget is enforced *between* steps as well as inside them, so fine-grained steps
 * are what let the governor stop at a clean boundary and still hand back complete
 * write-ups for everything it funded. A single mega-step under the same budget
 * either completes or returns one truncated blob — strictly worse as a partial
 * result, for the same money.
 */
export function buildSteps(exposures: readonly Exposure[]): readonly Step<PlanState>[] {
  const steps: Step<PlanState>[] = exposures.map((exposure) => {
    const signals = signalsFor(exposure);
    return {
      name: `writeup:${exposure.advisory.ghsaId}:${exposure.dependency.name}`,
      tier: signals.tier,
      complexity: () => ({ confidence: signals.confidence }),
      prompt: (state) =>
        [
          `You are drafting one entry of a dependency patch plan for the repository ${state.repo}.`,
          "",
          describe(exposure),
          "",
          "Write at most 120 words covering, in this order:",
          "1. the concrete risk to THIS repository, or that there is none and why;",
          "2. the exact remediation command;",
          "3. whether a human must read a changelog before applying it.",
          "State plainly if the advisory does not actually affect how this package is used.",
        ].join("\n"),
      apply: (state, text, meta) => ({
        ...state,
        writeups: [
          ...state.writeups,
          { ghsaId: exposure.advisory.ghsaId, text: text.trim(), truncated: meta.truncated },
        ],
      }),
    };
  });

  steps.push({
    name: "roll-up",
    tier: "mid",
    // The roll-up reasons over every write-up at once, so its input grows with how
    // much of the plan was funded; `inputChars` lets the router escalate when it is
    // genuinely a long-context job rather than guessing from severity.
    complexity: (state) => ({
      inputChars: state.writeups.reduce((n, w) => n + w.text.length, 0),
    }),
    prompt: (state) =>
      [
        `Summarise the patch plan for ${state.repo} in at most 150 words for an engineering lead.`,
        "Lead with what must be done today versus what can wait for the next sprint.",
        "",
        ...state.writeups.map((w) => `--- ${w.ghsaId}${w.truncated ? " (TRUNCATED)" : ""}\n${w.text}`),
      ].join("\n"),
    apply: (state, text) => ({ ...state, summary: text.trim() }),
  });

  return steps;
}

/**
 * Renders a run's state as markdown.
 *
 * Takes the *partial* state, not a completed run, and labels what is missing. A
 * governed run that stopped early produces a real, usable report with an explicit
 * "not funded" section rather than an error — that handoff is the feature being
 * demonstrated, so the reporter has to make the gap legible instead of hiding it.
 */
export function renderReport(
  state: PlanState,
  meta: { reason: string; spentUsd: number; budgetUsd: number; skipped: readonly string[] },
): string {
  const lines: string[] = [
    `# Dependency patch plan — ${state.repo}`,
    "",
    `- Exposures found: **${state.exposures.length}**`,
    `- Write-ups funded: **${state.writeups.length}/${state.exposures.length}**`,
    `- Spend: **$${meta.spentUsd.toFixed(6)}** of a **$${meta.budgetUsd.toFixed(4)}** budget`,
    `- Stop reason: **${meta.reason}**`,
    "",
  ];

  if (state.summary) {
    lines.push("## Summary", "", state.summary, "");
  } else {
    lines.push(
      "## Summary",
      "",
      "_Not generated: the run stopped before the roll-up step was funded._",
      "",
    );
  }

  lines.push("## Exposures", "");
  for (const [index, exposure] of state.exposures.entries()) {
    const writeup = state.writeups[index];
    lines.push(
      `### ${index + 1}. ${exposure.dependency.name} — ${exposure.advisory.ghsaId} (${exposure.advisory.severity})`,
      "",
      `${exposure.advisory.summary}`,
      "",
      `- Declared range: \`${exposure.dependency.range}\` (matched at \`${exposure.pinnedVersion}\`)`,
      `- Vulnerable range: \`${exposure.advisory.vulnerableRange}\``,
      `- First patched: \`${exposure.advisory.firstPatchedVersion ?? "none published"}\``,
      `- Advisory: ${exposure.advisory.url}`,
      "",
      writeup
        ? `${writeup.text}${writeup.truncated ? "\n\n_(truncated by the budget kill-switch)_" : ""}`
        : "_No write-up: not funded within the budget._",
      "",
    );
  }

  if (meta.skipped.length > 0) {
    lines.push(
      "## Not funded",
      "",
      "These steps were planned but never started, because the remaining budget could not",
      "cover even their best case:",
      "",
      ...meta.skipped.map((name) => `- \`${name}\``),
      "",
    );
  }

  return lines.join("\n");
}
