import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runGoverned } from "../governor.ts";
import { makeFetcher, resolveGithubToken } from "../net.ts";
import { resolveModels } from "../resolve.ts";
import { scanRepo } from "../task/cve-scan.ts";
import { buildSteps, initialState, renderReport } from "../task/patch-plan.ts";
import { PAGE } from "./page.ts";
import type { GovernorEvent } from "../types.ts";

/**
 * The live spend dashboard.
 *
 * `GET /` serves the page; `GET /api/run?repo=…&budget=…` streams the governor's
 * event feed as Server-Sent Events while the run is still in flight. SSE rather
 * than polling because the thing being demonstrated is that spend is observable
 * *during* a stream — a dashboard that polled a totals endpoint would show the same
 * number a post-hoc cost report shows, which is precisely the design this project
 * argues against.
 *
 * The HTTP request's own `close` is wired to an `AbortController` passed into the
 * governor, so closing the browser tab stops paid work instead of leaving it
 * running unobserved.
 */

/** Hard server-side ceiling, independent of whatever the client asks for. */
const MAX_BUDGET_USD = 0.25;

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleRun(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const repo = url.searchParams.get("repo") ?? "";
  const requested = Number(url.searchParams.get("budget") ?? "0.05");
  const [owner, name] = repo.split("/");

  if (!owner || !name) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "repo must be <owner>/<name>" }));
    return;
  }

  // Clamp rather than reject: a public dashboard anyone can trigger a run of must
  // not let a query parameter choose how much money to spend.
  const budgetUsd = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : 0.05,
    MAX_BUDGET_USD,
  );

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const { mode, resolve } = resolveModels(process.env["ANTHROPIC_API_KEY"]);
  sse(res, "mode", { mode, budgetUsd, clamped: budgetUsd < requested });

  try {
    const fetcher = makeFetcher();
    const token = resolveGithubToken(process.env, process.env["GITHUB_TOKEN_FILE"] ?? null);
    const { dependencies, exposures } = await scanRepo(
      owner,
      name,
      token ? { fetcher, token } : { fetcher },
    );
    sse(res, "scan", {
      dependencies: dependencies.length,
      exposures: exposures.map((e) => ({
        pkg: e.dependency.name,
        ghsa: e.advisory.ghsaId,
        severity: e.advisory.severity,
      })),
    });

    const result = await runGoverned({
      budgetUsd,
      resolve,
      steps: buildSteps(exposures),
      initialState: initialState(repo, exposures),
      signal: controller.signal,
      onEvent: (event: GovernorEvent) => sse(res, event.type, event),
    });

    sse(res, "report", {
      markdown: renderReport(result.partial, {
        reason: result.reason,
        spentUsd: result.spend.usd,
        budgetUsd: result.budgetUsd,
        skipped: result.skipped,
      }),
    });
  } catch (error) {
    sse(res, "fatal", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
}

export function createDashboard() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/run") {
      void handleRun(req, res, url);
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, maxBudgetUsd: MAX_BUDGET_USD }));
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
}

// Only listen when executed directly, so tests can import `createDashboard`
// and bind an ephemeral port without the module starting a second server.
if (process.argv[1]?.endsWith("dashboard/server.ts")) {
  const port = Number(process.env["PORT"] ?? 8787);
  createDashboard().listen(port, () => {
    process.stderr.write(`budget-keeper dashboard on http://localhost:${port}\n`);
  });
}
