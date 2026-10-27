import { createHash } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { CodingPrEventRepository } from './pr-events.ts';
import type { CodingSweepDeps } from './pr-sweep.ts';

export type CodingUnownedPr = { repo: string; number: number; title: string };
export type CodingUnownedNotice = { key: string; text: string };

export const codingUnownedPrKey = (row: CodingUnownedPr) =>
  `neo-pr-unowned:${row.repo}#${row.number}`;

export function planCodingUnownedNotice(
  rows: readonly CodingUnownedPr[]
): CodingUnownedNotice | null {
  if (!rows.length) return null;
  const keys = rows.map(codingUnownedPrKey);
  return {
    key: `neo-pr-unowned-batch:${createHash('sha256').update(keys.join('\n')).digest('hex')}`,
    text: `New pull requests observed without a known worker owner:\n${rows.map((row) => `${row.repo}#${row.number} "${row.title}" [${codingUnownedPrKey(row)}]`).join('\n')}\nCheck the current ledger before assigning an owner.`,
  };
}

export const wakeCodingUnownedPrs = (superpipe({})('coding-unowned-pr-wake') as PipelineAPI)
  .input(['repo', 'wake', 'now'])
  .pipe(
    async (repo: CodingPrEventRepository, now: number) => {
      const notice = await repo.pendingUnownedLater(now);
      return notice ? { value: notice } : { reason: 'no_unowned_prs' };
    },
    ['repo', 'now'],
    'result:notice'
  )
  .pipe(
    (notice: CodingUnownedNotice, wake: CodingSweepDeps['wake']) =>
      wake(notice.key, notice.text).catch(() => false),
    ['notice', 'wake'],
    'accepted'
  )
  .pipe(
    async (repo: CodingPrEventRepository, notice: CodingUnownedNotice, accepted: boolean) => {
      if (accepted) await repo.unownedDeliveredLater(notice.key);
    },
    ['repo', 'notice', 'accepted']
  )
  .endAsync() as (
  repo: CodingPrEventRepository,
  wake: CodingSweepDeps['wake'],
  now: number
) => Promise<void>;
