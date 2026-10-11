import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboard } from "../src/dashboard/server.ts";
import { runGoverned, type Step } from "../src/governor.ts";
import { CATALOG } from "../src/pricing.ts";
import { SimulatedClient } from "../src/providers/simulated.ts";
import {
  budgetBucket,
  DEFAULT_POSTHOG_HOST,
  reportRunCompleted,
  runCompletedProperties,
  TELEMETRY_TIMEOUT_MS,
  telemetryTarget,
  type RunSummaryInput,
} from "../src/telemetry.ts";
import type { StopReason, Tier } from "../src/types.ts";

/**
 * Telemetry is opt-in, anonymous and best-effort. These tests pin each of those
 * words down. `fetch` is always a stub: nothing here touches the network, and the
 * key is a fake that exists only in this file.
 */

const FAKE_KEY = "phc_FAKE_KEY_FOR_TESTS_ONLY";
const OPT_IN = { BUDGET_KEEPER_TELEMETRY: "1", POSTHOG_KEY: FAKE_KEY } as const;

const ALL_REASONS: readonly StopReason[] = [
  "completed",
  "budget-preflight",
  "budget-exhausted",
  "budget-killswitch",
  "caller-abort",
  "error",
];

const PROPERTY_KEYS = [
  "$geoip_disable",
  "$process_person_profile",
  "app",
  "budget_bucket",
  "killed",
  "outcome",
  "spent_pct",
  "surface",
  "tier_switches",
];

function summary(
  over: { reason?: StopReason; budgetUsd?: number; usd?: number; tiers?: Tier[] } = {},
): RunSummaryInput {
  return {
    reason: over.reason ?? "budget-exhausted",
    budgetUsd: over.budgetUsd ?? 0.08,
    spend: { usd: over.usd ?? 0.07995 },
    steps: (over.tiers ?? ["strong", "strong", "mid", "cheap"]).map((tier) => ({ tier })),
  };
}

interface Wire {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: {
    api_key: string;
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  };
}

let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchStub = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function wire(call = 0): Wire {
  const [url, init] = fetchStub.mock.calls[call] as [string, RequestInit];
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as Wire["body"],
  };
}

describe("opt-in gate: off unless explicitly enabled", () => {
  it("does nothing with an empty environment", async () => {
    await reportRunCompleted(summary(), {});
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("does nothing when only the key is set (a key alone is not consent)", async () => {
    await reportRunCompleted(summary(), { POSTHOG_KEY: FAKE_KEY });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each(["0", "", "true", "yes", "on", " 1", "1 ", "TRUE", "2"])(
    "does nothing when BUDGET_KEEPER_TELEMETRY is %j (only exactly 1 counts)",
    async (value) => {
      await reportRunCompleted(summary(), { BUDGET_KEEPER_TELEMETRY: value, POSTHOG_KEY: FAKE_KEY });
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "   "])("does nothing when opted in but the key is %j", async (key) => {
    await reportRunCompleted(summary(), { BUDGET_KEEPER_TELEMETRY: "1", POSTHOG_KEY: key });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each(["phx_personalApiKey", "phs_projectSecretKey"])(
    "refuses PostHog's secret key kinds (%s) rather than sending them in a request body",
    async (key) => {
      await reportRunCompleted(summary(), { BUDGET_KEEPER_TELEMETRY: "1", POSTHOG_KEY: key });
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it.each([
    "ftp://example.com",
    "not a url",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com",
  ])(
    "fails closed on an unusable POSTHOG_HOST (%s)",
    async (host) => {
      await reportRunCompleted(summary(), { ...OPT_IN, POSTHOG_HOST: host });
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "sends nothing for a run with no usable budget (%s)",
    async (budgetUsd) => {
      await reportRunCompleted(summary({ budgetUsd }), OPT_IN);
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it("reads only the environment it is handed, never process.env", async () => {
    vi.stubEnv("BUDGET_KEEPER_TELEMETRY", "1");
    vi.stubEnv("POSTHOG_KEY", FAKE_KEY);
    await reportRunCompleted(summary(), {});
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("opt-in with a key: exactly one allowlisted request", () => {
  it("POSTs one run_completed event to the US capture endpoint by default", async () => {
    await reportRunCompleted(summary(), OPT_IN);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const { url, init, headers, body } = wire();
    expect(DEFAULT_POSTHOG_HOST).toBe("https://us.i.posthog.com");
    expect(url).toBe("https://us.i.posthog.com/i/v0/e/");
    expect(init.method).toBe("POST");
    expect(headers).toEqual({ "content-type": "application/json" });

    expect(Object.keys(body).sort()).toEqual(["api_key", "distinct_id", "event", "properties"]);
    expect(body.api_key).toBe(FAKE_KEY);
    expect(body.event).toBe("run_completed");
    expect(body.distinct_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("carries exactly the documented properties, with the expected values", async () => {
    // 0.07995 / 0.08 = 99.9% -> 100. Tiers strong,strong,mid,cheap -> two switches.
    await reportRunCompleted(summary(), OPT_IN);
    const { properties } = wire().body;

    expect(Object.keys(properties).sort()).toEqual(PROPERTY_KEYS);
    expect(properties).toEqual({
      app: "budget-keeper",
      surface: "cli",
      $process_person_profile: false,
      $geoip_disable: true,
      budget_bucket: "0.05-0.25",
      spent_pct: 100,
      tier_switches: 2,
      killed: false,
      outcome: "budget-exhausted",
    });
  });

  it("uses a fresh anonymous id for every run", async () => {
    await reportRunCompleted(summary(), OPT_IN);
    await reportRunCompleted(summary(), OPT_IN);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(wire(0).body.distinct_id).not.toBe(wire(1).body.distinct_id);
  });

  it("honours POSTHOG_HOST, including a path prefix and a trailing slash", async () => {
    await reportRunCompleted(summary(), { ...OPT_IN, POSTHOG_HOST: "https://eu.i.posthog.com" });
    await reportRunCompleted(summary(), { ...OPT_IN, POSTHOG_HOST: "https://example.test/ingest/" });
    await reportRunCompleted(summary(), { ...OPT_IN, POSTHOG_HOST: "http://127.0.0.1:8123?x=1#y" });
    expect(wire(0).url).toBe("https://eu.i.posthog.com/i/v0/e/");
    expect(wire(1).url).toBe("https://example.test/ingest/i/v0/e/");
    expect(wire(2).url).toBe("http://127.0.0.1:8123/i/v0/e/");
  });

  it("treats an empty POSTHOG_HOST as unset", () => {
    expect(telemetryTarget({ ...OPT_IN, POSTHOG_HOST: "" })?.url).toBe(
      "https://us.i.posthog.com/i/v0/e/",
    );
  });

  it("marks a kill-switch run as killed, from a real governor run", async () => {
    // A provider that ignores its allowance is the only way to reach the kill-switch,
    // so drive the real governor with one and feed its real RunResult through.
    const steps: Step<string[]>[] = [
      {
        name: "overrun",
        tier: "cheap",
        prompt: () => "prompt",
        apply: (state, text) => [...state, text],
      },
    ];
    const result = await runGoverned({
      budgetUsd: 0.001,
      resolve: (tier) =>
        new SimulatedClient(CATALOG[tier], [
          { chunks: Array.from({ length: 4000 }, () => "x".repeat(40)), inputTokens: 0, ignoreAllowance: true },
        ]),
      steps,
      initialState: [],
    });
    expect(result.reason).toBe("budget-killswitch");

    await reportRunCompleted(result, OPT_IN);
    const { properties } = wire().body;
    expect(properties["killed"]).toBe(true);
    expect(properties["outcome"]).toBe("budget-killswitch");
    expect(properties["budget_bucket"]).toBe("<0.05");
    expect(properties["spent_pct"]).toBe(Math.round((result.spend.usd / 0.001) * 100));
    expect(properties["spent_pct"] as number).toBeGreaterThanOrEqual(100);
  });
});

describe("what is derived, and how", () => {
  it.each([
    [0.0001, "<0.05"],
    [0.0499, "<0.05"],
    [0.05, "0.05-0.25"], // the CLI default sits on a lower edge, which is inclusive
    [0.08, "0.05-0.25"],
    [0.2499, "0.05-0.25"],
    [0.25, "0.25-1"],
    [0.9999, "0.25-1"],
    [1, "1-10"],
    [9.99, "1-10"],
    [10, "10+"],
    [5000, "10+"],
  ] as const)("buckets a $%s budget as %s", (usd, bucket) => {
    expect(budgetBucket(usd)).toBe(bucket);
  });

  it.each([
    [0, 0],
    [0.0004, 1], // 0.5% rounds up
    [0.04, 50],
    [0.0799, 100],
    [0.08, 100],
    [0.0808, 101], // an overrun reads above 100
  ])("reports $%s of a $0.08 budget as %s%%, a rounded integer", (usd, pct) => {
    const properties = runCompletedProperties(summary({ budgetUsd: 0.08, usd }));
    expect(properties?.spent_pct).toBe(pct);
    expect(Number.isInteger(properties?.spent_pct)).toBe(true);
  });

  it.each([
    [[], 0],
    [["mid"], 0],
    [["mid", "mid", "mid"], 0],
    [["cheap", "mid"], 1],
    [["cheap", "mid", "cheap"], 2],
    [["strong", "strong", "mid", "mid", "cheap"], 2],
    [["cheap", "strong", "cheap", "strong"], 3],
  ] as [Tier[], number][])("counts tier switches in %j as %s", (tiers, switches) => {
    expect(runCompletedProperties(summary({ tiers }))?.tier_switches).toBe(switches);
  });

  it("reports every stop reason as itself, and killed only for the kill-switch", () => {
    for (const reason of ALL_REASONS) {
      const properties = runCompletedProperties(summary({ reason }));
      expect(properties?.outcome).toBe(reason);
      expect(properties?.killed).toBe(reason === "budget-killswitch");
    }
  });

  it("drops an outcome outside the closed list instead of forwarding it", () => {
    for (const reason of ["constructor", "__proto__", "toString", "unknown", "", "/home/me/secret"]) {
      const properties = runCompletedProperties(summary({ reason: reason as StopReason }));
      expect(properties).not.toBeNull();
      expect(Object.keys(properties ?? {})).not.toContain("outcome");
      expect(JSON.stringify(properties)).not.toContain(reason || "\u0000");
    }
  });

  it("only ever produces allowlisted values, across 300 seeded random runs", () => {
    let seed = 20261011;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    };
    const tiers: Tier[] = ["cheap", "mid", "strong"];
    const buckets = new Set(["<0.05", "0.05-0.25", "0.25-1", "1-10", "10+"]);

    for (let i = 0; i < 300; i++) {
      const budgetUsd = 10 ** (rand() * 5 - 3);
      const stepCount = Math.floor(rand() * 9);
      const run = summary({
        reason: ALL_REASONS[Math.floor(rand() * ALL_REASONS.length)] as StopReason,
        budgetUsd,
        usd: budgetUsd * rand() * 1.05,
        tiers: Array.from({ length: stepCount }, () => tiers[Math.floor(rand() * 3)] as Tier),
      });
      const p = runCompletedProperties(run);
      expect(p, `run ${i}`).not.toBeNull();
      if (!p) continue;
      expect(Object.keys(p).sort()).toEqual(PROPERTY_KEYS);
      expect(buckets.has(p.budget_bucket)).toBe(true);
      expect(Number.isInteger(p.spent_pct) && p.spent_pct >= 0 && p.spent_pct <= 106).toBe(true);
      expect(Number.isInteger(p.tier_switches)).toBe(true);
      expect(p.tier_switches).toBeLessThanOrEqual(Math.max(0, stepCount - 1));
      expect(typeof p.killed).toBe("boolean");
      expect(ALL_REASONS).toContain(p.outcome);
    }
  });
});

describe("no user content reaches the wire", () => {
  /** Records every property read, so a test can prove which fields were consulted. */
  function watched<T extends object>(target: T, label: string, reads: Set<string>): T {
    return new Proxy(target, {
      get(obj, prop, receiver) {
        if (typeof prop === "string") reads.add(`${label}.${prop}`);
        return Reflect.get(obj, prop, receiver);
      },
    });
  }

  const PLANTED = "PLANTED";
  const hostileRun = () => ({
    runId: `run_${PLANTED}`,
    reason: "completed" as StopReason,
    budgetUsd: 0.5,
    spend: { usd: 0.12, inputTokens: 9999, outputTokens: 8888 },
    overshootUsd: 0,
    skipped: [`${PLANTED}-skipped-step`],
    // The task text, a file path and an API key, in every place a run carries text.
    partial: {
      repo: `alice/${PLANTED}-private-repo`,
      note: `fix lodash in /home/alice/${PLANTED}/package.json using sk-ant-${PLANTED}`,
      exposures: [{ advisory: { summary: `${PLANTED} advisory` } }],
    },
    steps: [
      {
        name: `writeup:GHSA-${PLANTED}:lodash`,
        tier: "strong" as Tier,
        model: `model-${PLANTED}`,
        text: `${PLANTED} task text: rotate ghp_${PLANTED} found in /etc/${PLANTED}/secrets`,
        truncated: false,
        outputTokenCap: 1000,
        spend: { inputTokens: 1, outputTokens: 2, usd: 0.1 },
      },
      {
        name: `rollup:${PLANTED}`,
        tier: "cheap" as Tier,
        model: `model-${PLANTED}-small`,
        text: `${PLANTED} model output`,
        truncated: true,
        outputTokenCap: 10,
        spend: { inputTokens: 1, outputTokens: 2, usd: 0.02 },
      },
    ],
  });

  const hostileEnv = {
    ...OPT_IN,
    ANTHROPIC_API_KEY: `sk-ant-api03-${PLANTED}`,
    GITHUB_TOKEN: `ghp_${PLANTED}`,
    GH_TOKEN: `gho_${PLANTED}`,
    HOME: `/home/${PLANTED}`,
    USER: `${PLANTED}-user`,
    PWD: `/work/${PLANTED}`,
    PATH: `/opt/${PLANTED}/bin`,
    HOSTNAME: `${PLANTED}-host`,
  };

  it("sends none of a planted task text, path, token or API key", async () => {
    await reportRunCompleted(hostileRun(), hostileEnv);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    // The whole call (URL, headers, body), not just the body.
    const everything = JSON.stringify(fetchStub.mock.calls.map(([url, init]) => [url, { ...init, signal: undefined }]));
    expect(everything).not.toContain(PLANTED);
    expect(everything).not.toContain("sk-ant");
    expect(everything).not.toContain("ghp_");
    expect(everything).not.toContain("/home/");
    // The one secret-shaped thing that is sent is the opt-in project token, by design.
    expect(everything).toContain(FAKE_KEY);

    const { properties } = wire().body;
    expect(Object.keys(properties).sort()).toEqual(PROPERTY_KEYS);
    expect(properties["tier_switches"]).toBe(1);
  });

  it("reads only reason, budgetUsd, spend.usd and each step's tier from the run", async () => {
    const reads = new Set<string>();
    const run = hostileRun();
    const proxied = watched(
      {
        ...run,
        spend: watched(run.spend, "spend", reads),
        steps: run.steps.map((step, i) => watched(step, `steps[${i}]`, reads)),
      },
      "run",
      reads,
    );

    await reportRunCompleted(proxied, hostileEnv);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    const consulted = [...reads].map((r) => r.replace(/\[\d+\]/, "[]"));
    const allowed = new Set([
      "run.reason",
      "run.budgetUsd",
      "run.spend",
      "spend.usd",
      "run.steps",
      "steps[].tier",
    ]);
    for (const read of consulted) expect(allowed.has(read), `unexpected read of ${read}`).toBe(true);
  });

  it("sends only short, fixed-vocabulary strings in properties", async () => {
    await reportRunCompleted(hostileRun(), hostileEnv);
    for (const [key, value] of Object.entries(wire().body.properties)) {
      if (typeof value === "string") {
        expect(value.length, key).toBeLessThanOrEqual(17);
        expect(value, key).toMatch(/^[a-z0-9<>.+-]+$/);
      } else {
        expect(["number", "boolean"], key).toContain(typeof value);
      }
    }
  });
});

/** A fetch that, like the real one, never settles until its abort signal fires. */
function neverAnswers(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });
}

describe("failure never escapes", () => {
  it("swallows a network error", async () => {
    fetchStub.mockRejectedValue(new TypeError("fetch failed"));
    await expect(reportRunCompleted(summary(), OPT_IN)).resolves.toBeUndefined();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("swallows a synchronous throw from fetch itself", async () => {
    fetchStub.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(reportRunCompleted(summary(), OPT_IN)).resolves.toBeUndefined();
  });

  it("treats an HTTP error response as nothing happened", async () => {
    fetchStub.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(reportRunCompleted(summary(), OPT_IN)).resolves.toBeUndefined();
    fetchStub.mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(reportRunCompleted(summary(), OPT_IN)).resolves.toBeUndefined();
  });

  it("swallows a hostile environment object and a malformed run", async () => {
    const trap = new Proxy({}, { get: () => { throw new Error("env trap"); } });
    await expect(reportRunCompleted(summary(), trap as never)).resolves.toBeUndefined();
    await expect(
      reportRunCompleted({ reason: "completed", budgetUsd: 1 } as unknown as RunSummaryInput, OPT_IN),
    ).resolves.toBeUndefined();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("bounds the request with a 2000ms abort signal by default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await reportRunCompleted(summary(), OPT_IN);

    expect(TELEMETRY_TIMEOUT_MS).toBe(2000);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(2000);
    const signal = wire().init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("gives up on a server that never answers instead of hanging", async () => {
    fetchStub.mockImplementation(neverAnswers);
    const started = performance.now();
    await expect(reportRunCompleted(summary(), OPT_IN, { timeoutMs: 40 })).resolves.toBeUndefined();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(1500);
  });

  it("writes nothing to stdout, stderr or the console, on success or failure", async () => {
    const sinks = [
      vi.spyOn(process.stdout, "write"),
      vi.spyOn(process.stderr, "write"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ];

    await reportRunCompleted(summary(), {});
    await reportRunCompleted(summary(), OPT_IN);
    fetchStub.mockRejectedValue(new TypeError("fetch failed"));
    await reportRunCompleted(summary(), OPT_IN);
    fetchStub.mockImplementation(neverAnswers);
    await reportRunCompleted(summary(), OPT_IN, { timeoutMs: 20 });

    for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
  });
});

describe("the local dashboard is not instrumented", () => {
  const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);

  it("makes no telemetry request even with telemetry fully enabled", async () => {
    vi.stubEnv("BUDGET_KEEPER_TELEMETRY", "1");
    vi.stubEnv("POSTHOG_KEY", FAKE_KEY);
    vi.stubEnv("POSTHOG_HOST", "http://127.0.0.1:9");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GITHUB_TOKEN", "");

    const pkg = Buffer.from(JSON.stringify({ dependencies: { lodash: "4.17.15" } })).toString("base64");
    const advisory = {
      ghsa_id: "GHSA-35jh-r3h4-6jhm",
      severity: "high",
      summary: "Command Injection in lodash",
      cve_id: null,
      html_url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
      vulnerabilities: [
        {
          package: { ecosystem: "npm", name: "lodash" },
          vulnerable_version_range: "< 4.17.21",
          first_patched_version: "4.17.21",
        },
      ],
    };
    const seen: string[] = [];
    fetchStub.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      const body = url.includes("contents/package.json")
        ? { encoding: "base64", content: pkg }
        : url.includes("/advisories")
          ? [advisory]
          : {};
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const server = createDashboard();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await realFetch(`${base}/api/run?repo=o/r&budget=0.05`);
      const text = await response.text();
      expect(text).toContain("event: run-end");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      expect(new URL(url).hostname, url).toBe("api.github.com");
    }
  });

  it("does not import or mention the telemetry module", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../src/dashboard/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(/telemetry|posthog/i);
    }
  });
});
