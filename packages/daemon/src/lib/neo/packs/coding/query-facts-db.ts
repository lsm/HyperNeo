import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingQueryFactsRepository } from './query-facts.ts';

class CodingQueryCommands {
  constructor(private readonly db: Database) {}

  snapshot(...args: Parameters<CodingQueryFactsRepository['snapshot']>) {
    return new CodingQueryFactsRepository(this.db).snapshot(...args);
  }

  read(...args: Parameters<CodingQueryFactsRepository['read']>) {
    return new CodingQueryFactsRepository(this.db).read(...args);
  }

  observe(...args: Parameters<CodingQueryFactsRepository['observe']>) {
    return new CodingQueryFactsRepository(this.db).observe(...args);
  }
}

export const codingQueryReads = defineRepositoryOp(
  'coding.query.snapshot',
  'read',
  CodingQueryCommands,
  ['snapshot', 'read']
);
export const codingQueryWrites = defineRepositoryOp(
  'coding.query.observe',
  'write',
  CodingQueryCommands,
  ['observe']
);
