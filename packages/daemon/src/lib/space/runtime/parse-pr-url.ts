import type { EventInterest } from '@hyperneo/shared';

export interface ParsedPrUrl {
  host: string;
  owner: string;
  repo: string;
  number: string;
}

const PR_URL_PATTERN = /https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)(?:[/?#]|$|\b)/;

export function buildPrUrl(parsed: ParsedPrUrl): string {
  const host = parsed.host.toLowerCase();
  return `https://${host}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;
}

export function parsePrUrl(url: string): ParsedPrUrl | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const match = new RegExp(PR_URL_PATTERN.source, 'g').exec(url);
  if (!match) return null;
  return { host: match[1]!, owner: match[2]!, repo: match[3]!, number: match[4]! };
}

export function buildPrEventTopicPattern(parsed: ParsedPrUrl): string {
  return `github/${parsed.owner}/${parsed.repo}/pull_request/${parsed.number}.*`;
}

export const KNOWN_TOPIC_FROM_SOURCES: ReadonlySet<string> = new Set<string>(['primaryLink']);

export function resolveTopicFromInterest(
  interest: Pick<EventInterest, 'topicFrom'>,
  primaryLinkUrl: string | undefined | null,
  allowedHosts: ReadonlySet<string> = new Set(['github.com'])
): string | null {
  const { topicFrom } = interest;
  if (!topicFrom || !KNOWN_TOPIC_FROM_SOURCES.has(topicFrom.source)) return null;
  const parsed = parsePrUrl(typeof primaryLinkUrl === 'string' ? primaryLinkUrl : '');
  if (!parsed) return null;
  const normalizeHost = (value: string): string => value.toLowerCase().replace(/:\d+$/, '');
  const host = normalizeHost(parsed.host);
  if (![...allowedHosts].some((allowed) => normalizeHost(allowed) === host)) return null;
  const literalSegment = /^[a-zA-Z0-9._-]+$/;
  if (
    !literalSegment.test(parsed.owner) ||
    !literalSegment.test(parsed.repo) ||
    !literalSegment.test(parsed.number)
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
