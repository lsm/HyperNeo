import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingRefFactsRepository } from './ref-facts.ts';

class CodingRefCommands {
  constructor(private readonly db: Database) {}

  read(...args: Parameters<CodingRefFactsRepository['read']>) {
    return new CodingRefFactsRepository(this.db).read(...args);
  }

  observe(...args: Parameters<CodingRefFactsRepository['observe']>) {
    return new CodingRefFactsRepository(this.db).observe(...args);
  }
}

export const codingRefReads = defineRepositoryOp('coding.ref.snapshot', 'read', CodingRefCommands, [
  'read',
]);
export const codingRefWrites = defineRepositoryOp(
  'coding.ref.observe',
  'write',
  CodingRefCommands,
  ['observe']
);
