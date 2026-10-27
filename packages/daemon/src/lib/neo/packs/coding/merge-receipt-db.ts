import {
  readCodingMergeLocal,
  type CodingMergeLocalAdmission,
  type CodingMergeLocalRequest,
} from './merge-local-state.ts';
import { isDeepStrictEqual } from 'node:util';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingDeliveryFactsRepository, type CodingMergeGate } from './delivery-facts.ts';

class CodingMergeReceiptCommands {
  constructor(private readonly db: Database) {}

  snapshot(input: CodingMergeLocalRequest) {
    return readCodingMergeLocal(this.db, input);
  }

  record(todoId: string, gate: CodingMergeGate, admission?: CodingMergeLocalAdmission): boolean {
    if (admission && !isDeepStrictEqual(admission.state, this.snapshot(admission.input)))
      return false;
    const repo = new CodingDeliveryFactsRepository(this.db);
    repo.recordGate(todoId, gate);
    return isDeepStrictEqual(repo.read(todoId, gate.url, gate.head)?.gate, gate);
  }
}

export const codingMergeReceiptWrites = defineRepositoryOp(
  'coding.mergeReceipt.commit',
  'write',
  CodingMergeReceiptCommands,
  ['record', 'snapshot']
);
