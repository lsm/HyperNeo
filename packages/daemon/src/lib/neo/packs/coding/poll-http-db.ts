import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingPollFactsRepository } from './poll-facts.ts';

class CodingPollPageCommands {
  constructor(private readonly db: Database) {}
  read(...args: Parameters<CodingPollFactsRepository['read']>) {
    return new CodingPollFactsRepository(this.db).read(...args);
  }
  observe(...args: Parameters<CodingPollFactsRepository['record']>) {
    const facts = new CodingPollFactsRepository(this.db);
    const accepted = facts.record(...args);
    return { accepted, facts: facts.read(args[0], args[2], Infinity) };
  }
  prune(before: number) {
    return new CodingPollFactsRepository(this.db).pruneExternalEventPages(before);
  }
}
export const codingPollPageReads = defineRepositoryOp(
  'coding.pollPage.snapshot',
  'read',
  CodingPollPageCommands,
  ['read']
);
export const codingPollPageWrites = defineRepositoryOp(
  'coding.pollPage.observe',
  'write',
  CodingPollPageCommands,
  ['observe', 'prune']
);
