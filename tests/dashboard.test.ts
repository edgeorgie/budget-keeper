import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDashboard } from "../src/dashboard/server.ts";

/**
 * End-to-end over the real HTTP server on an ephemeral port, with `fetch` stubbed
 * at the GitHub-API boundary only. This exercises the whole path a visitor takes —
 * route, SSE framing, scan, governed run, report — rather than asserting the
 * handler's internals, because the claim being made is about a surface someone can
 * open in a browser.
 */

const PKG = Buffer.from(
  JSON.stringify({ dependencies: { lodash: "4.17.15" } }),
  "utf8",
).toString("base64");

const ADVISORY = {
  ghsa_id: "GHSA-35jh-r3h4-6jhm",
  severity: "high",
  summary: "Command Injection in lodash",
  cve_id: "CVE-2021-23337",
  html_url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
  vulnerabilities: [
    {
      package: { ecosystem: "npm", name: "lodash" },
      vulnerable_version_range: "< 4.17.21",
      first_patched_version: "4.17.21",
    },
  ],
};

let server: ReturnType<typeof createDashboard>;
let base = "";

/**
 * A handle on the genuine `fetch` captured before any stubbing, so the test can
 * talk to its own HTTP server while GitHub calls are intercepted. Taking this
 * reference at module load is what keeps the two concerns separable.
 */
const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

function json(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeAll(async () => {
  // Only GitHub API calls are stubbed; requests to our own server go through the
  // real stack. `ANTHROPIC_API_KEY` is explicitly absent so the simulated client
  // is used and no paid call can be made from a test run.
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("contents/package.json")) return json({ encoding: "base64", content: PKG });
    if (url.includes("/advisories")) return json([ADVISORY]);
    return realFetch(input, init);
  });

  server = createDashboard();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Reads the SSE body to completion and returns the raw text. */
async function readStream(path: string): Promise<string> {
  const response = await realFetch(`${base}${path}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  return await response.text();
}

function events(raw: string): { event: string; data: Record<string, unknown> }[] {
  return raw
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const event = /event: (.+)/.exec(block)?.[1] ?? "";
      const data = /data: (.+)/.exec(block)?.[1] ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

describe("dashboard HTTP surface", () => {
  it("serves a page that boots an EventSource", async () => {
    const response = await realFetch(`${base}/`);
    const html = await response.text();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("new EventSource");
    expect(html).toContain("budget-keeper");
    // Every input is labelled: the surface is meant to be usable, not just pretty.
    expect(html).toContain('aria-label="GitHub repository, owner slash name"');
  });

  it("answers /healthz with the server-side budget ceiling", async () => {
    const body = (await (await realFetch(`${base}/healthz`)).json()) as {
      ok: boolean;
      maxBudgetUsd: number;
    };
    expect(body.ok).toBe(true);
    expect(body.maxBudgetUsd).toBeGreaterThan(0);
  });

  it("rejects a malformed repo with 400 rather than starting a run", async () => {
    const response = await realFetch(`${base}/api/run?repo=nope`);
    expect(response.status).toBe(400);
  });

  it("404s an unknown route", async () => {
    expect((await realFetch(`${base}/nope`)).status).toBe(404);
  });

  it("streams scan, spend and report events for a real governed run", async () => {
    const raw = await readStream("/api/run?repo=o/r&budget=0.05");
    const parsed = events(raw);
    const names = parsed.map((e) => e.event);

    expect(names).toContain("mode");
    expect(names).toContain("scan");
    expect(names).toContain("run-start");
    expect(names).toContain("spend");
    expect(names).toContain("run-end");
    expect(names).toContain("report");

    // No API key is set in the test environment, so the run must declare itself
    // simulated — a dashboard that labelled fake spend as real would be worse
    // than no dashboard.
    expect(parsed.find((e) => e.event === "mode")?.data["mode"]).toBe("simulated");

    const scan = parsed.find((e) => e.event === "scan")?.data as {
      dependencies: number;
      exposures: { ghsa: string }[];
    };
    expect(scan.dependencies).toBe(1);
    expect(scan.exposures[0]?.ghsa).toBe("GHSA-35jh-r3h4-6jhm");

    const report = parsed.find((e) => e.event === "report")?.data as { markdown: string };
    expect(report.markdown).toContain("GHSA-35jh-r3h4-6jhm");
    expect(report.markdown).toContain("Dependency patch plan");
  });

  it("emits the report AFTER run-end, and the page waits for it", async () => {
    const raw = await readStream("/api/run?repo=o/r&budget=0.05");
    const names = events(raw).map((e) => e.event);
    const runEnd = names.indexOf("run-end");
    const report = names.indexOf("report");

    expect(runEnd).toBeGreaterThanOrEqual(0);
    expect(report).toBeGreaterThan(runEnd);

    // The ordering above is a trap for the client: closing the EventSource on
    // "run-end" discards the report every time. Pin the page's handling of it so
    // the bug cannot come back — `stop()` (which closes the stream) must be
    // reached from the report handler, not the run-end handler.
    const html = await (await realFetch(`${base}/`)).text();
    const runEndHandler = /addEventListener\("run-end"[\s\S]*?\n    \}\);/.exec(html)?.[0] ?? "";
    const reportHandler = /addEventListener\("report"[\s\S]*?\n    \}\);/.exec(html)?.[0] ?? "";
    expect(runEndHandler).not.toContain("stop(");
    expect(reportHandler).toContain("stop(");
  });

  it("clamps a client-supplied budget to the server ceiling", async () => {
    const raw = await readStream("/api/run?repo=o/r&budget=9999");
    const mode = events(raw).find((e) => e.event === "mode")?.data as {
      budgetUsd: number;
      clamped: boolean;
    };
    expect(mode.clamped).toBe(true);
    expect(mode.budgetUsd).toBeLessThanOrEqual(0.25);
  });

  it("emits a fatal event instead of hanging when the scan fails", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => "forbidden",
    }));
    const raw = await readStream("/api/run?repo=o/r&budget=0.01");
    expect(events(raw).some((e) => e.event === "fatal")).toBe(true);
  });
});
