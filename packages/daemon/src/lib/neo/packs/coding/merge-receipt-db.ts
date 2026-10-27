import { isDeepStrictEqual } from 'node:util';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingDeliveryFactsRepository, type CodingMergeGate } from './delivery-facts.ts';

class CodingMergeReceiptCommands {
  constructor(private readonly db: Database) {}

  record(todoId: string, gate: CodingMergeGate): boolean {
    const repo = new CodingDeliveryFactsRepository(this.db);
    repo.recordGate(todoId, gate);
    return isDeepStrictEqual(repo.read(todoId, gate.url, gate.head)?.gate, gate);
  }
}

export const codingMergeReceiptWrites = defineRepositoryOp(
  'coding.mergeReceipt.commit',
  'write',
  CodingMergeReceiptCommands,
  ['record']
);
