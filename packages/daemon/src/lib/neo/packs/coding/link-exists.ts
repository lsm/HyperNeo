import { type LedgerQuotaRun, runCodingGh } from './ledger-quota.ts';

type Probe = { path: string; parent?: { field: string; suffix: string } };
const RETRY_MS = 5 * 60_000;
const hosts = () => new Set(['github.com', process.env.GH_HOST?.toLowerCase()].filter(Boolean));

function parse(url: string): URL | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && hosts().has(parsed.hostname.toLowerCase())
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function probe(parsed: URL): Probe | null {
  const match =
    /^\/([\w.-]+)\/([\w.-]+)\/(?:(pull|issues)\/([1-9]\d*)(?:\/files)?|commit\/([0-9a-f]{7,40}))\/?$/i.exec(
      parsed.pathname
    );
  const anchor = /^#(issuecomment-|pullrequestreview-|discussion_r)(\d+)$/.exec(parsed.hash);
  if (!match || (parsed.hash && !anchor)) return null;
  const [, owner, repo, kind, number, sha] = match;
  const base = `repos/${owner}/${repo}`;
  const pull = kind?.toLowerCase() === 'pull';
  if (sha) return anchor ? null : { path: `${base}/commits/${sha}` };
  if (!anchor) return { path: `${base}/issues/${number}` };
  if (anchor[1] === 'issuecomment-')
    return {
      path: `${base}/issues/comments/${anchor[2]}`,
      parent: { field: 'issue_url', suffix: `/issues/${number}` },
    };
  if (!pull) return null;
  return anchor[1] === 'pullrequestreview-'
    ? { path: `${base}/pulls/${number}/reviews/${anchor[2]}` }
    : {
        path: `${base}/pulls/comments/${anchor[2]}`,
        parent: { field: 'pull_request_url', suffix: `/pulls/${number}` },
      };
}

export function codingLinkIsComment(url: string): boolean | null {
  const parsed = parse(url);
  return parsed ? !!probe(parsed)?.parent || /^#pullrequestreview-/.test(parsed.hash) : null;
}

export function createCodingLinkExists(run: LedgerQuotaRun = runCodingGh, now = Date.now) {
  const seen = new Map<string, { at: number; value: Promise<boolean> }>();
  async function read(target: Probe): Promise<boolean> {
    const result = await run(['gh', 'api', target.path], 'core');
    if (!result.ok) return false;
    if (!target.parent) return true;
    const parent = (result.data as Record<string, unknown> | null)?.[target.parent.field];
    return typeof parent === 'string' && parent.toLowerCase().endsWith(target.parent.suffix);
  }
  return (url: string): Promise<boolean | null> => {
    const parsed = parse(url);
    if (!parsed) return Promise.resolve(null);
    const target = probe(parsed);
    if (!target) return Promise.resolve(false);
    const key = `${target.path} ${target.parent?.suffix ?? ''}`;
    const cached = seen.get(key);
    if (cached && now() - cached.at < RETRY_MS) return cached.value;
    const value = read(target).catch(() => false);
    seen.set(key, { at: now(), value });
    void value.then((exists) => exists && seen.delete(key));
    return value;
  };
}
