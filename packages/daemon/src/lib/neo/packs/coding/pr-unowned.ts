import { codingPrKey } from './pr-key.ts';
import type { CodingAttend } from './attention.ts';
import type { CodingPrEventRepository } from './pr-events.ts';

export type CodingUnownedPr = { repo: string; number: number; title: string };

export const codingPrMayBeInRunningTurn = (
  createdAt: number | null,
  lastTurnEnds: readonly (number | null)[]
) => lastTurnEnds.some((endedAt) => (endedAt ?? 0) < (createdAt ?? 0));

export function planCodingUnclaimedPrs<Row extends CodingUnownedPr>(
  rows: readonly Row[],
  claims: ReadonlySet<string>
) {
  return rows.filter(
    (row) => !claims.has(codingPrKey(`https://github.com/${row.repo}/pull/${row.number}`)!)
  );
}

export async function wakeCodingUnownedPrs(
  repo: CodingPrEventRepository,
  attend: CodingAttend,
  now: number
): Promise<void> {
  for (const row of await repo.unownedLater(now))
    await attend({
      kind: 'coding.pr_unowned',
      subject: { type: 'pr', id: `${row.repo}#${row.number}` },
      since: row.createdAt,
      facts: {
        text: `New pull request observed without a known worker owner: ${row.repo}#${row.number} "${row.title}". Check the current ledger before assigning an owner.`,
      },
    }).catch(() => false);
}
