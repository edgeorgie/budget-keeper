# ADR 0001: Opt-in, shape-only CLI telemetry

- **Status:** implemented, not verified end to end. Accepted by the owner as a Tier 3
  (opt-in CLI) case in the portfolio's PostHog rollout plan; no live PostHog project has
  received an event from this code.
- **Date:** 2026-10-11

## Context

The portfolio's PostHog plan lists `budget-keeper` as an opt-in CLI with one event,
`run_completed`, off unless `BUDGET_KEEPER_TELEMETRY=1`. The repo is deliberately
dependency-light (`semver` is the only runtime dependency), runs from source with Node's
type stripping, and its pitch is that a budget is a constraint rather than an accounting
line. Telemetry that spent money, leaked task content or changed a run's outcome would
contradict that.

## Decision

- **Opt-in needs two things:** `BUDGET_KEEPER_TELEMETRY=1` (exactly `1`) and a `POSTHOG_KEY`
  project token. Either alone does nothing. There is no embedded token. A `phx_` personal
  API key or `phs_` project secret key is refused, because those must never go in an event
  body.
- **No SDK.** One `fetch` POST to `{POSTHOG_HOST}/i/v0/e/` (default host
  `https://us.i.posthog.com`) with `api_key`, `event`, `distinct_id` and `properties`, which
  is the single-event shape in PostHog's capture API reference (checked 2026-10-11).
  `posthog-node` would add a dependency tree to a tool whose runtime tree is one package.
- **Best effort, bounded:** `AbortSignal.timeout(2000)`; every error swallowed; started as soon
  as the run ends and awaited just before `process.exit`, so it overlaps with writing the
  report and can delay exit by at most 2 seconds. It never writes to stdout or stderr and
  never touches the exit code.
- **Anonymous by construction:** a fresh `crypto.randomUUID()` per run, `$process_person_profile:
  false`, `$geoip_disable: true`. Nothing is stored on disk and nothing about the machine or
  person is hashed into an id.
- **Allowlist, not serialisation.** `runCompletedProperties` builds the object field by field
  from `reason`, `budgetUsd`, `spend.usd` and each step's `tier`. Its input type names only
  those fields, and a test records every property read on a hostile run object to prove nothing
  else is consulted.
- **Event:** `run_completed` with `budget_bucket`, `spent_pct`, `tier_switches`, `killed`, and
  `outcome`.
  - `budget_bucket` edges are `<0.05`, `0.05-0.25`, `0.25-1`, `1-10`, `10+` (lower edge
    inclusive). They follow the tool's own numbers: the CLI default is 0.05 and the
    dashboard's server-side ceiling is 0.25. Five coarse buckets keep an exact budget out of
    the data.
  - `tier_switches` counts adjacent executed steps on different tiers. A step refused
    pre-flight never ran, so it is not counted.
  - `killed` is exactly `reason === "budget-killswitch"`. A caller abort is not "killed" here.
    The CLI does not pass an abort signal to the governor today, so `caller-abort` is in the
    list but not produced; Ctrl-C ends the process before any event is sent.
  - `outcome` is the existing closed `StopReason` union. A `satisfies Record<StopReason, true>`
    table makes a new stop reason a compile error until someone decides it is safe to report.
- **The dashboard is not instrumented.** It is a localhost server that can be pointed at by
  anyone's browser; it does not import the telemetry module, and a test enforces that
  statically and by running a dashboard request with telemetry fully enabled.
- **Not added:** model names (the three ids in `CATALOG` are a closed list and not content, but
  `tier_switches` answers the routing question without them), step names or counts, a
  `--telemetry` flag, a first-run notice and a `--print-telemetry` dry run. The README lists
  exactly what is sent, and pointing `POSTHOG_HOST` at a local listener shows the request.

## Deviations from the rollout plan (section 2.4)

The plan's generic CLI recipe has a `--telemetry` flag, a hashed `machine_id` with a salt in
`~/.config/<tool>/telemetry.json`, and a one-line notice on the first enabled run. This
implementation uses the environment variable only, a fresh id per run, no file and no notice.
That is less capable (no cross-run identity) and strictly less invasive (no file written, no
stable identifier), and opt-in here is already an explicit environment variable the README
documents. `outcome` is one property beyond the plan's row of four, added because `StopReason`
is already a closed enum in the code.

## Open questions for the owner

1. **Embed a public write-only project token for opt-in users?** Today nobody but the holder of
   a key can send to the owner's project, so in practice only the owner's own runs arrive. An
   embedded `phc_` token would let other opt-in users report to the owner's project; it is
   public by design but is an owner decision, so none is committed.
2. **Add `mode` (`live` or `simulated`)?** With no `ANTHROPIC_API_KEY` the tool runs a
   deterministic simulator, which is the default path, so simulated and real runs are
   indistinguishable in the data. `RunMode` is already a closed enum, so adding it is one
   property, but it extends the plan's allowlist, so it is left for the owner to approve.
3. **Update the plan row** to include `outcome` (and `mode`, if approved).
4. **PostHog project settings:** enable "Discard client IP data". The request carries the
   sender's IP like any HTTP request; `$geoip_disable` only stops location enrichment.

## What was and was not verified

Verified: unit tests with a stubbed `fetch` (gate, allowlist, planted-secret absence, timeout,
failure swallowing, no console output); the real CLI as a child process against a local HTTP
server (one request, unchanged stdout/stderr/exit code, bounded wait on a host that never
answers); the dashboard sending nothing; mutation checks that each of those guards fails when
its code is removed.

Not verified: any event arriving in, or being accepted by, a real PostHog project. The path
`/i/v0/e/`, the body shape and `$process_person_profile` are taken from PostHog's capture API
reference. `$geoip_disable` is the property the official Node SDK sets for its `disableGeoip`
option (seen in that SDK's source); it is not described on the capture API reference page. The
effect of the IP-discard project setting on API-captured events was not observed.
