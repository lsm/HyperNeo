import { codingPrKey } from './pr-key.ts';
import { createHash } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { CodingPrEventRepository } from './pr-events.ts';
import type { CodingSweepDeps } from './pr-sweep.ts';

export type CodingUnownedPr = { repo: string; number: number; title: string };
export type CodingUnownedNotice = { key: string; text: string };

export const codingPrMayBeInRunningTurn = (
  createdAt: number | null,
  lastTurnEnds: readonly (number | null)[]
) => lastTurnEnds.some((endedAt) => (endedAt ?? 0) < (createdAt ?? 0));

export const codingUnownedPrKey = (row: CodingUnownedPr) =>
  `neo-pr-unowned:${row.repo}#${row.number}`;

export function planCodingUnclaimedPrs<Row extends CodingUnownedPr>(
  rows: readonly Row[],
  claims: ReadonlySet<string>
) {
  return rows.filter(
    (row) => !claims.has(codingPrKey(`https://github.com/${row.repo}/pull/${row.number}`)!)
  );
}

export function planCodingUnownedNotice(
  rows: readonly CodingUnownedPr[],
  deliveryKey?: string
): CodingUnownedNotice | null {
  if (!rows.length) return null;
  const keys = rows.map(codingUnownedPrKey);
  return {
    key:
      deliveryKey ??
      `neo-pr-unowned-batch:${createHash('sha256').update(keys.join('\n')).digest('hex')}`,
    text: `New pull requests observed without a known worker owner:\n${rows.map((row) => `${row.repo}#${row.number} "${row.title}" [${codingUnownedPrKey(row)}]`).join('\n')}\nCheck the current ledger before assigning an owner.`,
  };
}

const wakeUnowned = (superpipe({})('coding-unowned-pr-wake') as PipelineAPI)
  .input(['repo', 'wake', 'now', 'delivery'])
  .pipe(
    async (repo: CodingPrEventRepository, now: number, delivery: CodingSweepDeps['delivery']) => {
      const pending = delivery ? await repo.pendingDeliveryLater().catch(() => null) : null;
      if (delivery && !pending) return { reason: 'receipt_unavailable' };
      const currentRecipient = delivery?.recipient() ?? null;
      const recipient = pending?.key ? (pending.recipient ?? null) : currentRecipient;
      if (delivery && !pending?.key && !recipient) return { reason: 'no_recipient' };
      const status = pending?.key
        ? pending.recipient
          ? await delivery!.status(pending.recipient, pending.key).catch(() => 'unknown' as const)
          : ('unknown' as const)
        : ('absent' as const);
      const notice = await repo.pendingUnownedLater(
        now,
        delivery ? { key: pending!.key, recipient: currentRecipient, status } : undefined
      );
      return notice
        ? {
            value: {
              notice,
              recipient: notice.key === pending?.key ? recipient : currentRecipient,
            },
          }
        : { reason: 'no_unowned_prs' };
    },
    ['repo', 'now', 'delivery'],
    'result:prepared'
  )
  .pipe(
    (
      prepared: { notice: CodingUnownedNotice; recipient: string | null },
      wake: CodingSweepDeps['wake'],
      delivery: CodingSweepDeps['delivery']
    ) => {
      const { notice, recipient } = prepared;
      return (
        delivery && recipient
          ? delivery.send(recipient, notice.key, notice.text)
          : wake(notice.key, notice.text)
      ).catch(() => false);
    },
    ['prepared', 'wake', 'delivery'],
    'accepted'
  )
  .pipe(
    async (
      repo: CodingPrEventRepository,
      prepared: { notice: CodingUnownedNotice },
      accepted: boolean
    ) => {
      if (accepted) await repo.unownedDeliveredLater(prepared.notice.key);
    },
    ['repo', 'prepared', 'accepted']
  )
  .endAsync() as (
  repo: CodingPrEventRepository,
  wake: CodingSweepDeps['wake'],
  now: number,
  delivery: CodingSweepDeps['delivery']
) => Promise<void>;

export function wakeCodingUnownedPrs(
  repo: CodingPrEventRepository,
  wake: CodingSweepDeps['wake'],
  now: number,
  delivery?: CodingSweepDeps['delivery']
) {
  return repo.exclusive(() => wakeUnowned(repo, wake, now, delivery));
}
