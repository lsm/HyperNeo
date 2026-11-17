import { Logger } from '../../../logger.ts';
import type { NeoAttentionEvent } from '../../attention/decide.ts';
import type { CodingPrLedgerRepository } from './pr-ledger.ts';

const log = new Logger('NeoCodingHealth');
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
  if (!repos.length) return;
  const events = (await ledger.readHealthDelivery(repos, now - PENDING_STALE_MS)).flatMap(
    ({ repo, incident, pending }) => [
      ...(incident && incident.resolvedAt === null
        ? [
            event(
              { type: 'repo', id: repo },
              incident.raisedAt,
              `GitHub coverage stalled for ${repo}. Incident ${incident.key}.`
            ),
          ]
        : []),
      ...pending.map((row) =>
        event(
          { type: 'pr_head', id: `${repo}#${row.number}@${row.head}` },
          row.readAt,
          `GitHub readiness observation stalled for ${repo}#${row.number} (approved_pending, head ${row.head.slice(0, 7)}) since ${new Date(row.readAt).toISOString()}. Current CI is unverified; check polling before acting.`
        )
      ),
    ]
  );
  for (const item of events)
    await attend(item).catch((error) =>
      log.warn(`GitHub health ${item.subject.id} not told; the next sweep retries`, error)
    );
}
