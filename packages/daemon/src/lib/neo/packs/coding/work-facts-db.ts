import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingWorkFactsRepository } from './work-facts.ts';

class CodingWorkCommands {
  constructor(private readonly db: Database) {}

  read(...args: Parameters<CodingWorkFactsRepository['read']>) {
    return new CodingWorkFactsRepository(this.db).read(...args);
  }

  observe(...args: Parameters<CodingWorkFactsRepository['observe']>) {
    return new CodingWorkFactsRepository(this.db).observe(...args);
  }
}

export const codingWorkReads = defineRepositoryOp(
  'coding.work.snapshot',
  'read',
  CodingWorkCommands,
  ['read']
);
export const codingWorkWrites = defineRepositoryOp(
  'coding.work.observe',
  'write',
  CodingWorkCommands,
  ['observe']
);
