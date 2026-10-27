import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingPrLedgerRepository } from './pr-ledger.ts';

class CodingLedgerPollQueries {
  constructor(private readonly db: Database) {}

  snapshot(repos: readonly string[]) {
    return new CodingPrLedgerRepository(this.db).pollSnapshot(repos);
  }

  context(repo: string) {
    return new CodingPrLedgerRepository(this.db).pollContext(repo);
  }
}

export const codingLedgerPollReads = defineRepositoryOp(
  'coding.ledger.pollReads',
  'read',
  CodingLedgerPollQueries,
  ['snapshot', 'context']
);
