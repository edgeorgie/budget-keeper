// Preloaded into the CLI by the end-to-end telemetry tests (`node --import`). It
// answers the two GitHub API calls a scan makes from canned data, so the real CLI
// runs offline and deterministically; every other request goes to the real `fetch`
// (in the tests, that is the local capture server).
const realFetch = globalThis.fetch;

const PACKAGE_JSON = JSON.stringify({ dependencies: { lodash: "4.17.15" } });

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

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.github.com/")) {
    if (url.includes("/contents/package.json")) {
      return json({ encoding: "base64", content: Buffer.from(PACKAGE_JSON).toString("base64") });
    }
    if (url.includes("/advisories")) return json([ADVISORY]);
    return new Response("not stubbed", { status: 404 });
  }
  return realFetch(input, init);
};
