import type { EventInterest } from '@hyperneo/shared';

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
 * - `resolveTopicFromInterest` — to fill `topicFrom` placeholders
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

/**
 * Recognized {@link EventInterest.topicFrom} `source` values.
 *
 * Each source resolves a different placeholder vocabulary from a workflow run's
 * durable state. `primaryLink` fills placeholders from the run's primary GitHub
 * link (PR URL) via {@link parsePrUrl}. Extensible: a future source (a task
 * field, an artifact, …) adds an entry here plus a resolver branch in
 * {@link resolveTopicFromInterest}.
 */
export const KNOWN_TOPIC_FROM_SOURCES: ReadonlySet<string> = new Set<string>(['primaryLink']);

/**
 * Resolve a `topicFrom`-style {@link EventInterest} into a concrete topic glob
 * pattern by filling the `pattern`'s placeholders from the run's primary link.
 *
 * For the `primaryLink` source the supported placeholders are `{owner}`,
 * `{repo}`, and `{number}` — the segments of the GitHub event topic taxonomy
 * (`github/{owner}/{repo}/{resource}/{entity}.{action}`), all derived from
 * {@link parsePrUrl}. `{host}` is intentionally NOT supported: GitHub events are
 * published host-agnostic (always under the literal `github/` source prefix, per
 * `github-normalizer`), so a `{host}`-derived segment can never match. Any
 * unsupported token (e.g. `{host}`, `{branch}`) is left as-is and surfaces as an
 * invalid glob at registration.
 *
 * Returns `null` when:
 * - the interest has no `topicFrom` (it is a static `topic` interest — callers
 *   use `interest.topic` directly), or
 * - the `source` is not a known resolver, or
 * - the primary link cannot be parsed as a GitHub PR URL (malformed, an issue
 *   URL, a non-GitHub host, or empty).
 *
 * Pure: no I/O, no logging. The caller decides what to do with `null` (skip the
 * interest, defer until a link exists, …). Resolved topics are validated as glob
 * patterns by the trie at registration time, so unknown placeholders left in the
 * template (which would yield invalid characters) surface there.
 *
 * Example:
 * ```ts
 * resolveTopicFromInterest(
 *   { topicFrom: { source: 'primaryLink', pattern: 'github/{owner}/{repo}/pull_request/{number}.*' } },
 *   'https://github.com/lsm/neokai/pull/42',
 * ) === 'github/lsm/neokai/pull_request/42.*'
 * ```
 */
export function resolveTopicFromInterest(
  interest: Pick<EventInterest, 'topicFrom'>,
  primaryLinkUrl: string | undefined | null
): string | null {
  const { topicFrom } = interest;
  // The known-sources set is the single switch point: a source must be admitted
  // here before its resolver branch runs. Adding a source means adding it to the
  // set plus a `case` below — never a silent null elsewhere. Without this gate a
  // source the manager validator accepts would be unresolved here (returns null).
  if (!topicFrom || !KNOWN_TOPIC_FROM_SOURCES.has(topicFrom.source)) return null;
  const parsed = parsePrUrl(typeof primaryLinkUrl === 'string' ? primaryLinkUrl : '');
  if (!parsed) return null;
  // Treat resolved identity components as literals: the trie treats `*` as a
  // wildcard, so a malformed primary link such as `github/*/*/pull/42` must not
  // expand into a subscription that matches every repository. A real GitHub
  // owner/repo/host/number never contains `*`, so refuse to resolve if any does.
  if (
    parsed.owner.includes('*') ||
    parsed.repo.includes('*') ||
    parsed.number.includes('*') ||
    parsed.host.includes('*')
  ) {
    return null;
  }
  switch (topicFrom.source) {
    case 'primaryLink':
      return topicFrom.pattern
        .replaceAll('{owner}', parsed.owner)
        .replaceAll('{repo}', parsed.repo)
        .replaceAll('{number}', parsed.number);
    default:
      return null;
  }
}
