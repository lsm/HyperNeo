import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingMergeFactsRepository } from './merge-facts.ts';

class CodingMergeCommands {
  constructor(private readonly db: Database) {}
  read(...args: Parameters<CodingMergeFactsRepository['read']>) {
    return new CodingMergeFactsRepository(this.db).read(...args);
  }
  observe(...args: Parameters<CodingMergeFactsRepository['observe']>) {
    return new CodingMergeFactsRepository(this.db).observe(...args);
  }
}
export const codingMergeReads = defineRepositoryOp(
  'coding.merge.snapshot',
  'read',
  CodingMergeCommands,
  ['read']
);
export const codingMergeWrites = defineRepositoryOp(
  'coding.merge.observe',
  'write',
  CodingMergeCommands,
  ['observe']
);
