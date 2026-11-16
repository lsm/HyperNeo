import type { NeoAttentionEvent } from '../../attention/decide.ts';
import type { CodingPrLedgerRepository } from './pr-ledger.ts';

const PENDING_STALE_MS = 15 * 60_000;

const event = (subject: NeoAttentionEvent['subject'], since: number, text: string) => ({
  kind: 'coding.github_health',
  subject,
  since,
  facts: { text },
});

export async function deliverCodingHealth(
  ledger: CodingPrLedgerRepository,
  repos: readonly string[],
  attend: (event: NeoAttentionEvent) => Promise<unknown>,
  now: number
): Promise<void> {
  const keys = new Set(repos.map((repo) => repo.toLowerCase()));
  const rows = await ledger.read('list');
  for (const repo of keys) {
    const health = await ledger.readHealthCurrent(repo);
    if (!health) continue;
    const canonical = ledger.canonicalRepo(repo);
    if (health.incident && health.incident.resolvedAt === null)
      await attend(
        event(
          { type: 'repo', id: repo },
          health.incident.raisedAt,
          `GitHub coverage stalled for ${repo}. Incident ${health.incident.key}.`
        )
      );
    if (health.reason === 'complete') continue;
    for (const row of rows)
      if (
        row.repo === canonical &&
        row.state === 'approved_pending' &&
        row.closedAt === null &&
        now - row.readAt >= PENDING_STALE_MS
      )
        await attend(
          event(
            { type: 'pr_head', id: `${row.repo}#${row.number}@${row.head}` },
            row.readAt,
            `GitHub readiness observation stalled for ${row.repo}#${row.number} (approved_pending, head ${row.head.slice(0, 7)}) since ${new Date(row.readAt).toISOString()}. Current CI is unverified; check polling before acting.`
          )
        );
  }
}
