import type { NeoConcernBoard } from './neo-concern-board.ts';

type Receipt = NeoConcernBoard['receipts'][number];

export function neoBoardReceiptLabel(receipt: Receipt, receipts: readonly Receipt[]): string {
  if (receipt.kind === 'work') return receipt.title;
  const related = receipts.find(
    (item) =>
      item.kind === 'work' &&
      receipt.id === `neo-work:${item.id}:review` &&
      receipt.requestKey === receipt.id &&
      receipt.concernId === item.concernId
  );
  return related?.kind === 'work' ? `Context review · ${related.title}` : 'Context check';
}
