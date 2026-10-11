import { readFileSync } from "node:fs";
import { scanRepo, type Fetcher } from "./task/cve-scan.ts";

export { scanRepo };

/**
 * A `Fetcher` over Node's global `fetch` with two behaviours the scan relies on:
 * a bounded retry on GitHub's secondary rate limit (403 + `retry-after`), and a
 * hard failure on anything else, so a scan never silently reports zero exposures
 * because the API was unhappy. A monitor that reports "no vulnerabilities" when it
 * actually failed to look is the worst possible failure mode for this task.
 */
export function makeFetcher(opts: { retries?: number } = {}): Fetcher {
  const retries = opts.retries ?? 2;
  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { headers: init?.headers });
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      const rateLimited =
        response.status === 429 || (response.status === 403 && retryAfter > 0);
      if (!rateLimited || attempt >= retries) return response;
      await new Promise((r) => setTimeout(r, Math.max(retryAfter, 1) * 1000));
    }
  };
}

/**
 * Resolves a GitHub token from the environment or a file.
 *
 * The file option exists because exporting a token into the environment leaks it
 * into shell history and into the process table for anything that can read
 * `/proc`. A path lets an operator keep the credential in a mode-600 file. The
 * token is never logged or echoed by this tool — only whether one was found.
 */
export function resolveGithubToken(env: Record<string, string | undefined>, tokenFile: string | null): string | undefined {
  if (tokenFile) {
    const value = readFileSync(tokenFile, "utf8").trim();
    if (value) return value;
  }
  return env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
}
