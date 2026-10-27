import superpipe, { type PipelineAPI } from 'superpipe';
import { emitStructuredLogEvent } from '../../../logger.ts';
import type { HealthNotice } from './health-state.ts';
import type { CodingPrLedgerRepository } from './pr-ledger.ts';
import type { CodingSweepDeps } from './pr-sweep.ts';

const deliverNotice = (superpipe({})('coding-health-notice-delivery') as PipelineAPI)
  .input(['ledger', 'repo', 'notice', 'wake', 'now'])
  .pipe(
    (notice: HealthNotice, wake: CodingSweepDeps['wake']) =>
      wake(notice.key, notice.text).catch(() => false),
    ['notice', 'wake'],
    'accepted'
  )
  .pipe(
    async (
      ledger: CodingPrLedgerRepository,
      repo: string,
      notice: HealthNotice,
      accepted: boolean,
      now: number
    ) => {
      if (accepted) await ledger.write('acceptHealthNotice', repo, notice.key, now);
      return accepted;
    },
    ['ledger', 'repo', 'notice', 'accepted', 'now'],
    'accepted'
  )
  .endAsync('accepted') as (
  ledger: CodingPrLedgerRepository,
  repo: string,
  notice: HealthNotice,
  wake: CodingSweepDeps['wake'],
  now: number
) => Promise<boolean>;

export async function deliverCodingHealth(
  ledger: CodingPrLedgerRepository,
  repos: readonly string[],
  wake: CodingSweepDeps['wake'],
  now: number
): Promise<void> {
  for (const repo of new Set(repos.map((repo) => repo.toLowerCase()))) {
    const health = await ledger.write('readHealth', repo);
    for (const notice of health?.notices ?? []) {
      if (notice.acceptedAt !== null) continue;
      emitStructuredLogEvent({
        level: 'info',
        source: 'logger',
        module: 'coding-health',
        args: ['Repository coverage notice'],
        metadata: {
          repo,
          key: notice.key,
          pending: notice.pending,
          coverage: health!.reason,
          lagMs: Math.max(0, now - (health!.completeAt ?? health!.firstMissAt ?? now)),
          nextRetryAt: health!.nextRetryAt,
        },
      });
      if (!(await deliverNotice(ledger, repo, notice, wake, now))) break;
    }
  }
}
