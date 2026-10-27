import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingPrEventRepository } from './pr-events.ts';
import type { CodingPrTransition } from './pr-ledger.ts';

class CodingPrEventQueries {
  constructor(private readonly db: Database) {}

  pendingEvents() {
    return new CodingPrEventRepository(this.db).pendingEvents();
  }

  route(row: Pick<CodingPrTransition, 'repo' | 'number'>) {
    return new CodingPrEventRepository(this.db).route(row);
  }
}

export const codingPrEventReads = defineRepositoryOp(
  'coding.prEvent.reads',
  'read',
  CodingPrEventQueries,
  ['pendingEvents', 'route']
);
