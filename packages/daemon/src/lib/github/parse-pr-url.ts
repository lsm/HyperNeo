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

export const GITHUB_REF_PATH = /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/;

export function parseGitHubRefUrl(
  url: string
): { owner: string; repo: string; number: number } | null {
  const [, owner, repo, number] = GITHUB_REF_PATH.exec(url) ?? [];
  return owner && repo && number ? { owner, repo, number: Number(number) } : null;
}

export function githubUrlKey(url: string): string {
  return url.toLowerCase();
}

export function githubGraphqlArgs(
  query: string,
  ref: { owner: string; repo: string; number: string | number }
): string[] {
  return [
    'gh',
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `o=${ref.owner}`,
    '-f',
    `n=${ref.repo}`,
    '-F',
    `p=${ref.number}`,
  ];
}

export function buildPrEventTopicPattern(parsed: ParsedPrUrl): string {
  return `github/${parsed.owner}/${parsed.repo}/pull_request/${parsed.number}.*`;
}

export interface GitHubTopic {
  owner: string;
  repo: string;
  resource: string;
  entity: string;
  action: string;
}

export function parseGitHubTopic(topic: string): GitHubTopic | null {
  const [source, owner, repo, resource = '', entityAction = ''] = topic.split('/');
  if (source !== 'github' || !owner || !repo) return null;
  const dot = entityAction.indexOf('.');
  return {
    owner,
    repo,
    resource,
    entity: dot < 0 ? entityAction : entityAction.slice(0, dot),
    action: dot < 0 ? '' : entityAction.slice(dot + 1),
  };
}

export const KNOWN_TOPIC_FROM_SOURCES: ReadonlySet<string> = new Set<string>(['primaryLink']);

export function pullRequestNumbersOfTopics(
  topics: readonly string[],
  owner: string,
  repo: string
): number[] {
  const numbers = new Set<number>();
  for (const topic of topics) {
    const parsed = parseGitHubTopic(topic);
    if (
      parsed?.resource === 'pull_request' &&
      /^\d+$/.test(parsed.entity) &&
      parsed.owner.toLowerCase() === owner.toLowerCase() &&
      parsed.repo.toLowerCase() === repo.toLowerCase()
    )
      numbers.add(Number(parsed.entity));
  }
  return [...numbers];
}
