import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The real CLI, end to end, as a child process. The unit tests prove the module
 * behaves; only this proves `cli.ts` actually calls it at the right moment, waits for
 * it no longer than its timeout, and leaves output and exit code exactly as they were.
 *
 * Nothing leaves the machine: a preloaded stub answers the two GitHub API calls from
 * canned data, and the PostHog "host" is a throwaway HTTP server on 127.0.0.1.
 */

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const STUB_GITHUB = pathToFileURL(new URL("./fixtures/stub-github.mjs", import.meta.url).pathname).href;
const FAKE_KEY = "phc_FAKE_KEY_FOR_TESTS_ONLY";

interface Captured {
  method: string | undefined;
  url: string | undefined;
  body: {
    api_key: string;
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  };
}

interface Capture {
  readonly origin: string;
  readonly requests: Captured[];
  close(): Promise<void>;
}

const servers: Server[] = [];

/** A stand-in for the PostHog host. `hang` receives the request and never answers. */
async function capture(mode: "ok" | "hang" = "ok"): Promise<Capture> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(raw) as Captured["body"] });
      if (mode === "hang") return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"Ok"}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Variables that could change what the CLI does; the test sets any it wants itself. */
const SCRUBBED = [
  "BUDGET_KEEPER_TELEMETRY",
  "POSTHOG_KEY",
  "POSTHOG_HOST",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN_FILE",
];

function runCli(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const name of SCRUBBED) delete childEnv[name];
  Object.assign(childEnv, env);

  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "--import", STUB_GITHUB, CLI, ...args],
      { env: childEnv as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
  });
}

/** Run ids embed the start time, so they are the one legitimate difference between runs. */
const normalise = (text: string) => text.replace(/run_[0-9a-z]+/g, "run_X");

const BUDGET_SMALL = ["--repo", "o/r", "--budget", "0.08"];
const BUDGET_LARGE = ["--repo", "o/r", "--budget", "1"];
const TIMEOUT = 30_000;

describe("the CLI with telemetry off", () => {
  it(
    "sends nothing, even with a key and a host set, unless BUDGET_KEEPER_TELEMETRY=1",
    async () => {
      const host = await capture();
      const out = await runCli(BUDGET_SMALL, { POSTHOG_KEY: FAKE_KEY, POSTHOG_HOST: host.origin });
      expect(out.code).toBe(0);
      expect(host.requests).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "sends nothing when opted in without a key",
    async () => {
      const host = await capture();
      const out = await runCli(BUDGET_SMALL, { BUDGET_KEEPER_TELEMETRY: "1", POSTHOG_HOST: host.origin });
      expect(out.code).toBe(0);
      expect(host.requests).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "sends nothing for a run that never starts (usage error exits 2, as before)",
    async () => {
      const host = await capture();
      const out = await runCli(["--repo", "nope"], {
        BUDGET_KEEPER_TELEMETRY: "1",
        POSTHOG_KEY: FAKE_KEY,
        POSTHOG_HOST: host.origin,
      });
      expect(out.code).toBe(2);
      expect(host.requests).toHaveLength(0);
    },
    TIMEOUT,
  );
});

describe("the CLI with telemetry on", () => {
  it(
    "sends exactly one run_completed and changes neither output nor exit code",
    async () => {
      const host = await capture();
      const off = await runCli(BUDGET_SMALL);
      const on = await runCli(BUDGET_SMALL, {
        BUDGET_KEEPER_TELEMETRY: "1",
        POSTHOG_KEY: FAKE_KEY,
        POSTHOG_HOST: host.origin,
      });

      expect(off.code).toBe(0);
      expect(on.code).toBe(off.code);
      expect(on.stdout).toBe(off.stdout);
      expect(normalise(on.stderr)).toBe(normalise(off.stderr));
      expect(on.stderr.toLowerCase()).not.toMatch(/posthog|telemetry/);

      expect(host.requests).toHaveLength(1);
      const [request] = host.requests as [Captured];
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/i/v0/e/");
      expect(request.body.api_key).toBe(FAKE_KEY);
      expect(request.body.event).toBe("run_completed");
      expect(request.body.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.body.properties).toEqual({
        app: "budget-keeper",
        surface: "cli",
        $process_person_profile: false,
        $geoip_disable: true,
        budget_bucket: "0.05-0.25",
        spent_pct: 100,
        tier_switches: 0,
        killed: false,
        outcome: "budget-preflight",
      });
    },
    TIMEOUT,
  );

  it(
    "reports what the run's own event stream says happened",
    async () => {
      // Derive the expected values independently, from the `--json` event stream the
      // same process printed, instead of from the code under test.
      const host = await capture();
      const out = await runCli([...BUDGET_LARGE, "--json"], {
        BUDGET_KEEPER_TELEMETRY: "1",
        POSTHOG_KEY: FAKE_KEY,
        POSTHOG_HOST: host.origin,
      });
      expect(out.code).toBe(0);

      const events = out.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string });
      const tiers = events.filter((e) => e.type === "step-start").map((e) => e["tier"]);
      const end = events.find((e) => e.type === "run-end") as unknown as {
        reason: string;
        spend: { usd: number };
      };
      const expectedSwitches = tiers.filter((tier, i) => i > 0 && tier !== tiers[i - 1]).length;

      expect(tiers.length).toBeGreaterThan(1);
      expect(expectedSwitches).toBeGreaterThan(0);
      expect(host.requests).toHaveLength(1);
      const { properties } = (host.requests as [Captured])[0].body;
      expect(properties["tier_switches"]).toBe(expectedSwitches);
      expect(properties["outcome"]).toBe(end.reason);
      expect(properties["killed"]).toBe(false);
      expect(properties["budget_bucket"]).toBe("1-10");
      expect(properties["spent_pct"]).toBe(Math.round(end.spend.usd * 100));
    },
    TIMEOUT,
  );

  it(
    "carries nothing the scan read or the model wrote",
    async () => {
      const host = await capture();
      await runCli(BUDGET_LARGE, {
        BUDGET_KEEPER_TELEMETRY: "1",
        POSTHOG_KEY: FAKE_KEY,
        POSTHOG_HOST: host.origin,
        ANTHROPIC_API_KEY: "",
        GITHUB_TOKEN: "ghp_PLANTED_GITHUB_TOKEN",
      });
      expect(host.requests).toHaveLength(1);
      const wire = JSON.stringify(host.requests);
      for (const content of ["lodash", "GHSA", "o/r", "PLANTED", "package.json", "tier-", "block", "/home"]) {
        expect(wire, content).not.toContain(content);
      }
    },
    TIMEOUT,
  );

  it(
    "survives an unreachable host with the same output and exit code",
    async () => {
      const off = await runCli(BUDGET_SMALL);
      const on = await runCli(BUDGET_SMALL, {
        BUDGET_KEEPER_TELEMETRY: "1",
        POSTHOG_KEY: FAKE_KEY,
        POSTHOG_HOST: "http://127.0.0.1:1",
      });
      expect(on.code).toBe(0);
      expect(on.stdout).toBe(off.stdout);
      expect(normalise(on.stderr)).toBe(normalise(off.stderr));
    },
    TIMEOUT,
  );

  it(
    "never holds exit for more than the 2s timeout when the host never answers",
    async () => {
      const host = await capture("hang");
      const off = await runCli(BUDGET_SMALL);
      const on = await runCli(BUDGET_SMALL, {
        BUDGET_KEEPER_TELEMETRY: "1",
        POSTHOG_KEY: FAKE_KEY,
        POSTHOG_HOST: host.origin,
      });

      expect(on.code).toBe(0);
      expect(on.stdout).toBe(off.stdout);
      expect(normalise(on.stderr)).toBe(normalise(off.stderr));
      // The request was made, and then abandoned at the timeout rather than awaited forever.
      expect(host.requests).toHaveLength(1);
      expect(on.ms).toBeGreaterThan(1900);
      expect(on.ms - off.ms).toBeLessThan(2000 + 2500);
    },
    TIMEOUT,
  );
});
