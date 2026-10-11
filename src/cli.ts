import { writeFileSync } from "node:fs";
import { runGoverned } from "./governor.ts";
import { makeFetcher, resolveGithubToken } from "./net.ts";
import { resolveModels } from "./resolve.ts";
import { scanRepo } from "./task/cve-scan.ts";
import { buildSteps, initialState, renderReport } from "./task/patch-plan.ts";
import type { GovernorEvent } from "./types.ts";

interface Args {
  readonly repo: string;
  readonly budgetUsd: number;
  readonly out: string | null;
  readonly json: boolean;
  readonly tokenFile: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  let repo = "";
  let budgetUsd = 0.05;
  let out: string | null = null;
  let json = false;
  let tokenFile: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i] ?? "";
    else if (arg === "--budget") budgetUsd = Number(argv[++i] ?? "0.05");
    else if (arg === "--out") out = argv[++i] ?? null;
    else if (arg === "--token-file") tokenFile = argv[++i] ?? null;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") repo = "";
  }

  if (!repo.includes("/") || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    process.stderr.write(
      [
        "budget-keeper — a cost-governed dependency patch-plan agent",
        "",
        "Usage:",
        "  npm run keeper -- --repo <owner>/<name> [--budget <usd>] [--out report.md] [--json]",
        "",
        "Options:",
        "  --repo        GitHub repository to scan (required), e.g. expressjs/express",
        "  --budget      hard USD ceiling for the whole run (default 0.05)",
        "  --out         write the markdown patch plan to this path",
        "  --token-file  read a GitHub token from this file instead of the environment",
        "  --json        emit the governor event stream as JSONL on stdout",
        "",
        "Credentials (both optional):",
        "  GITHUB_TOKEN       raises the GitHub API rate limit (60/hr unauthenticated)",
        "  ANTHROPIC_API_KEY  switches from the deterministic simulator to real inference",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }

  return { repo, budgetUsd, out, json, tokenFile };
}

function human(event: GovernorEvent): string | null {
  switch (event.type) {
    case "run-start":
      return `» run ${event.runId} — budget $${event.budgetUsd.toFixed(4)}, ${event.plannedSteps} steps planned`;
    case "tier-decision":
      return `  · step ${event.step} tier=${event.chosen} (${event.reason})`;
    case "step-start":
      return `  → step ${event.step} ${event.name} on ${event.model} (allowance ${event.outputTokenCap} out tok)`;
    case "step-end":
      return `  ✓ step ${event.step} $${event.spend.usd.toFixed(6)}${event.truncated ? " (truncated)" : ""}`;
    case "step-error":
      return `  ! step ${event.step} ${event.name} failed: ${event.message}`;
    case "allowance-exhausted":
      return `  ⊣ step ${event.step} used its full allowance of ${event.outputTokenCap} output tokens`;
    case "preflight-refusal":
      return `  ✗ step ${event.step} REFUSED pre-flight: needs $${event.worstCaseUsd.toFixed(6)}, only $${event.remainingUsd.toFixed(6)} left`;
    case "killswitch":
      return `  ⛔ KILL-SWITCH at step ${event.step}: provider overran its allowance, $${event.spentUsd.toFixed(6)} vs budget $${event.budgetUsd.toFixed(4)}`;
    case "run-end":
      return `» end ${event.reason} — spent $${event.spend.usd.toFixed(6)} (${event.spend.inputTokens} in / ${event.spend.outputTokens} out)`;
    // `spend` fires on every chunk; far too noisy for the human log, and it is what
    // `--json` and the dashboard's SSE stream are for.
    case "spend":
      return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [owner, name] = args.repo.split("/");
  if (!owner || !name) throw new Error(`unparseable repo: ${args.repo}`);

  const { mode, resolve } = resolveModels(process.env["ANTHROPIC_API_KEY"]);
  process.stderr.write(`inference mode: ${mode}\n`);
  if (mode === "simulated") {
    process.stderr.write(
      "  (no ANTHROPIC_API_KEY — token counts and dollar figures below are from the\n" +
        "   deterministic simulator, not a real provider bill)\n",
    );
  }

  const fetcher = makeFetcher();
  const token = resolveGithubToken(process.env, args.tokenFile);
  process.stderr.write(`github auth: ${token ? "token supplied" : "unauthenticated (60 req/hr)"}\n`);
  process.stderr.write(`scanning ${args.repo}…\n`);
  const { dependencies, exposures } = await scanRepo(owner, name, token ? { fetcher, token } : { fetcher });
  process.stderr.write(
    `  ${dependencies.length} declared dependencies, ${exposures.length} exposed to a published advisory\n`,
  );

  const steps = buildSteps(exposures);
  const result = await runGoverned({
    budgetUsd: args.budgetUsd,
    resolve,
    steps,
    initialState: initialState(args.repo, exposures),
    onEvent: (event) => {
      if (args.json) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
      }
      const line = human(event);
      if (line) process.stderr.write(`${line}\n`);
    },
  });

  const report = renderReport(result.partial, {
    reason: result.reason,
    spentUsd: result.spend.usd,
    budgetUsd: result.budgetUsd,
    skipped: result.skipped,
  });

  if (args.out) {
    writeFileSync(args.out, report, "utf8");
    process.stderr.write(`report written to ${args.out}\n`);
  } else if (!args.json) {
    process.stdout.write(`\n${report}`);
  }

  // A budget stop is the governor working, not an error: exit 0. Only a genuine
  // step failure is a non-zero exit, so CI and shell callers can distinguish them.
  process.exit(result.reason === "error" ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
