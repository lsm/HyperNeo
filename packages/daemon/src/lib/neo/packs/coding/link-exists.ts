import { type LedgerQuotaRun, runCodingGh } from './ledger-quota.ts';

const Link =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:(pull|issues)\/([1-9]\d*)|commit\/([0-9a-f]{7,40}))\/?(?:#(issuecomment|pullrequestreview|discussion_r)-?(\d+))?$/i;

function codingLinkPath(url: string): string | null {
  const match = Link.exec(url.trim());
  if (!match) return null;
  const [, owner, repo, kind, number, sha, anchor, id] = match;
  const base = `repos/${owner}/${repo}`;
  if (sha) return anchor ? null : `${base}/commits/${sha}`;
  if (anchor === 'issuecomment') return `${base}/issues/comments/${id}`;
  if (anchor === 'pullrequestreview')
    return kind === 'pull' ? `${base}/pulls/${number}/reviews/${id}` : null;
  if (anchor === 'discussion_r') return kind === 'pull' ? `${base}/pulls/comments/${id}` : null;
  return `${base}/issues/${number}`;
}

export async function codingLinkExists(
  url: string,
  run: LedgerQuotaRun = runCodingGh
): Promise<boolean | null> {
  const path = codingLinkPath(url);
  return path ? (await run(['api', path], 'core')).ok : null;
}
