/**
 * The dashboard page, inlined as a string.
 *
 * Deliberately dependency-free: no bundler, no framework, no build step for the UI.
 * The whole point of the surface is to show a number changing while a stream is
 * open, and a 200-line page with an `EventSource` does that honestly. Adding a
 * frontend toolchain here would add build surface and CI time without making the
 * claim any more credible.
 */
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>budget-keeper — live spend governor</title>
<style>
  :root {
    --bg: #0b0d10; --panel: #13171c; --line: #242a31; --text: #e8eaed;
    --dim: #8b949e; --ok: #3fb950; --warn: #d29922; --bad: #f85149; --accent: #58a6ff;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text); font-family: var(--mono);
    font-size: 13px; line-height: 1.55;
  }
  header { padding: 20px 24px 16px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 4px; font-size: 15px; letter-spacing: .02em; }
  .sub { color: var(--dim); font-size: 12px; }
  main { padding: 20px 24px; display: grid; gap: 16px; max-width: 1100px; }
  form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input, button {
    font: inherit; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px;
  }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { cursor: pointer; border-color: var(--accent); color: var(--accent); }
  button[disabled] { opacity: .5; cursor: default; }
  .gauge { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .figures { display: flex; gap: 28px; flex-wrap: wrap; margin-bottom: 12px; }
  .fig small { display: block; color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .fig b { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar { height: 10px; background: #1b2026; border-radius: 999px; overflow: hidden; }
  .bar > i { display: block; height: 100%; width: 0; background: var(--ok); transition: width .12s linear; }
  .bar.warn > i { background: var(--warn); }
  .bar.bad > i { background: var(--bad); }
  #log { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
         padding: 12px 14px; max-height: 340px; overflow: auto; white-space: pre-wrap; }
  #log div { padding: 1px 0; }
  .t-dim { color: var(--dim); } .t-ok { color: var(--ok); }
  .t-warn { color: var(--warn); } .t-bad { color: var(--bad); } .t-acc { color: var(--accent); }
  #report { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
            padding: 12px 14px; white-space: pre-wrap; display: none; max-height: 420px; overflow: auto; }
  .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px;
           padding: 1px 9px; font-size: 11px; color: var(--dim); }
</style>
</head>
<body>
<header>
  <h1>budget-keeper</h1>
  <div class="sub">A hard per-run USD ceiling, metered mid-stream. Watch the gauge move while the agent is still talking.</div>
</header>
<main>
  <form id="f">
    <label for="repo" class="t-dim">repo</label>
    <input id="repo" name="repo" value="expressjs/express" size="26" aria-label="GitHub repository, owner slash name">
    <label for="budget" class="t-dim">budget USD</label>
    <input id="budget" name="budget" value="0.02" size="8" inputmode="decimal" aria-label="Budget in US dollars">
    <button id="go" type="submit">Run</button>
    <span id="mode" class="badge">idle</span>
  </form>

  <section class="gauge" aria-live="polite">
    <div class="figures">
      <div class="fig"><small>spent</small><b id="spent">$0.000000</b></div>
      <div class="fig"><small>remaining</small><b id="left">—</b></div>
      <div class="fig"><small>tokens in / out</small><b id="tok">0 / 0</b></div>
      <div class="fig"><small>step</small><b id="step">—</b></div>
      <div class="fig"><small>status</small><b id="status">idle</b></div>
    </div>
    <div class="bar" id="bar"><i></i></div>
  </section>

  <section id="log" aria-label="Governor event log"></section>
  <section id="report" aria-label="Patch plan report"></section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var es = null, budget = 0;

  function line(text, cls) {
    var d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    $("log").appendChild(d);
    $("log").scrollTop = $("log").scrollHeight;
  }

  function usd(n) { return "$" + Number(n).toFixed(6); }

  function gauge(spentUsd, inTok, outTok) {
    var pct = budget > 0 ? Math.min(100, (spentUsd / budget) * 100) : 0;
    $("spent").textContent = usd(spentUsd);
    $("left").textContent = usd(Math.max(0, budget - spentUsd));
    $("tok").textContent = inTok + " / " + outTok;
    var bar = $("bar");
    bar.className = "bar" + (pct >= 100 ? " bad" : pct >= 70 ? " warn" : "");
    bar.firstElementChild.style.width = pct.toFixed(2) + "%";
  }

  function stop(label, cls) {
    $("status").textContent = label;
    $("status").className = cls || "";
    $("go").disabled = false;
    if (es) { es.close(); es = null; }
  }

  $("f").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (es) es.close();
    $("log").textContent = "";
    $("report").style.display = "none";
    $("go").disabled = true;
    $("status").textContent = "scanning";
    $("status").className = "t-acc";

    var repo = $("repo").value.trim();
    budget = Number($("budget").value) || 0.05;
    gauge(0, 0, 0);

    // Per-step running total: the governor reports spend per step, so the run
    // total is the sum of finished steps plus the live step's current spend.
    var banked = 0, bankedIn = 0, bankedOut = 0;

    es = new EventSource("/api/run?repo=" + encodeURIComponent(repo) + "&budget=" + budget);

    es.addEventListener("mode", function (e) {
      var d = JSON.parse(e.data);
      budget = d.budgetUsd;
      $("mode").textContent = d.mode === "live" ? "live inference" : "simulated inference";
      $("mode").className = "badge " + (d.mode === "live" ? "t-ok" : "t-warn");
      if (d.clamped) line("! budget clamped by the server to " + usd(d.budgetUsd), "t-warn");
      gauge(0, 0, 0);
    });

    es.addEventListener("scan", function (e) {
      var d = JSON.parse(e.data);
      line(d.dependencies + " declared dependencies, " + d.exposures.length + " exposed", "t-acc");
      d.exposures.forEach(function (x) {
        line("  · " + x.pkg + " — " + x.ghsa + " (" + x.severity + ")", "t-dim");
      });
      $("status").textContent = "running";
    });

    es.addEventListener("run-start", function (e) {
      var d = JSON.parse(e.data);
      line("» run " + d.runId + " — budget " + usd(d.budgetUsd) + ", " + d.plannedSteps + " steps", "t-acc");
    });

    es.addEventListener("tier-decision", function (e) {
      var d = JSON.parse(e.data);
      line("  tier=" + d.chosen + " — " + d.reason, "t-dim");
    });

    es.addEventListener("step-start", function (e) {
      var d = JSON.parse(e.data);
      $("step").textContent = "#" + d.step;
      line("  → " + d.name + " on " + d.model);
    });

    es.addEventListener("spend", function (e) {
      var d = JSON.parse(e.data);
      gauge(banked + d.spend.usd, bankedIn + d.spend.inputTokens, bankedOut + d.spend.outputTokens);
    });

    es.addEventListener("step-end", function (e) {
      var d = JSON.parse(e.data);
      banked += d.spend.usd; bankedIn += d.spend.inputTokens; bankedOut += d.spend.outputTokens;
      gauge(banked, bankedIn, bankedOut);
      line("  ✓ " + d.name + " " + usd(d.spend.usd) + (d.truncated ? " (truncated)" : ""), "t-ok");
    });

    es.addEventListener("preflight-refusal", function (e) {
      var d = JSON.parse(e.data);
      line("  ✗ step " + d.step + " refused pre-flight: needs " + usd(d.worstCaseUsd) +
           ", only " + usd(d.remainingUsd) + " left", "t-warn");
    });

    es.addEventListener("allowance-exhausted", function (e) {
      var d = JSON.parse(e.data);
      line("  ⊣ step " + d.step + " used its full allowance of " + d.outputTokenCap + " output tokens", "t-warn");
    });

    es.addEventListener("killswitch", function (e) {
      var d = JSON.parse(e.data);
      line("  ⛔ KILL-SWITCH at step " + d.step + ": provider overran its allowance, " +
           usd(d.spentUsd) + " vs budget " + usd(d.budgetUsd), "t-bad");
    });

    es.addEventListener("run-end", function (e) {
      var d = JSON.parse(e.data);
      line("» " + d.reason + " — spent " + usd(d.spend.usd), "t-acc");
      // Status only: the stream stays OPEN here on purpose. The server emits the
      // rendered report AFTER the governor's own "run-end", so closing the
      // EventSource at this point would discard the report every time.
      $("status").textContent = d.reason;
      $("status").className = d.reason === "completed" ? "t-ok" : "t-warn";
    });

    es.addEventListener("report", function (e) {
      $("report").textContent = JSON.parse(e.data).markdown;
      $("report").style.display = "block";
      stop($("status").textContent, $("status").className);
    });

    es.addEventListener("fatal", function (e) {
      line("fatal: " + JSON.parse(e.data).message, "t-bad");
      stop("failed", "t-bad");
    });

    es.onerror = function () {
      // The server ends the stream after "run-end"; EventSource reports that as an
      // error and would otherwise reconnect and start a second paid run.
      if ($("go").disabled) stop("disconnected", "t-warn");
    };
  });
})();
</script>
</body>
</html>`;
