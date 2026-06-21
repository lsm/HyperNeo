/**
 * Parse a GitHub pull-request URL into its host/owner/repo/number components.
 *
 * Accepts both `https://github.com/owner/repo/pull/123` and the canonical
 * `/files` / `/commits` / `/reviews` suffixes. Returns `null` for non-PR URLs
 * (issues, commits, or non-GitHub hosts) so callers can short-circuit without
 * try/catch.
 *
 * Shared by:
 * - `pr-ready-validator.ts` — to scope `gh api graphql` calls
 * - `space-runtime.ts` — to build the GitHub event topic pattern when
 *   auto-subscribing a blocked run to PR reaction/review events
 */
export interface ParsedPrUrl {
  host: string;
  owner: string;
  repo: string;
  number: string;
}

const PR_URL_PATTERN = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)(?:[/?#]|$)/;

export function parsePrUrl(url: string): ParsedPrUrl | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const match = url.match(PR_URL_PATTERN);
  if (!match) return null;
  return { host: match[1]!, owner: match[2]!, repo: match[3]!, number: match[4]! };
}

/**
 * Build the glob topic pattern used to auto-subscribe a blocked workflow run
 * to GitHub events for a specific PR. Matches reaction, review, and status
 * events published by the GitHub external-event source.
 *
 * Example: `github/owner/repo/pull_request/123.*`
 */
export function buildPrEventTopicPattern(parsed: ParsedPrUrl): string {
  return `github/${parsed.owner}/${parsed.repo}/pull_request/${parsed.number}.*`;
}
