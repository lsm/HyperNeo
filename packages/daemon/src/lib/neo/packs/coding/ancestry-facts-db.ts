import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingAncestryFactsRepository } from './ancestry-facts.ts';

class CodingAncestryCommands {
  constructor(private readonly db: Database) {}

  read(...args: Parameters<CodingAncestryFactsRepository['read']>) {
    return new CodingAncestryFactsRepository(this.db).read(...args);
  }

  observe(...args: Parameters<CodingAncestryFactsRepository['observe']>) {
    return new CodingAncestryFactsRepository(this.db).observe(...args);
  }
}

export const codingAncestryReads = defineRepositoryOp(
  'coding.ancestry.snapshot',
  'read',
  CodingAncestryCommands,
  ['read']
);
export const codingAncestryWrites = defineRepositoryOp(
  'coding.ancestry.observe',
  'write',
  CodingAncestryCommands,
  ['observe']
);
