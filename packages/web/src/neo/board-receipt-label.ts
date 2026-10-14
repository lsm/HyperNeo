import type { NeoProjectBoard } from './neo-project-board.ts';

type Receipt = NeoProjectBoard['receipts'][number];

const reviewedWorkId = (id: string) =>
  /^neo-work:(.+):review(?::retry:\d+)?(?::continued:\d+)?$/.exec(id)?.[1] ?? null;

export function neoBoardReceiptLabel(receipt: Receipt, receipts: readonly Receipt[]): string {
  if (receipt.kind === 'work') return receipt.title;
  const workId = reviewedWorkId(receipt.id);
  const related = receipts.find(
    (item) =>
      item.kind === 'work' &&
      item.id === workId &&
      receipt.requestKey === receipt.id &&
      receipt.projectId === item.projectId
  );
  return related?.kind === 'work' ? `Context review · ${related.title}` : 'Context check';
}
