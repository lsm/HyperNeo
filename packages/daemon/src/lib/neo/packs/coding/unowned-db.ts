import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingPrEventRepository } from './pr-events.ts';

class CodingUnownedCommands {
  constructor(private readonly db: Database) {}

  delivery() {
    return new CodingPrEventRepository(this.db).pendingDelivery();
  }

  pending(...args: Parameters<CodingPrEventRepository['pendingUnowned']>) {
    return new CodingPrEventRepository(this.db).pendingUnowned(...args);
  }

  acknowledge(key: string) {
    return new CodingPrEventRepository(this.db).unownedDelivered(key);
  }
}

export const codingUnownedWrites = defineRepositoryOp(
  'coding.unowned.commands',
  'write',
  CodingUnownedCommands,
  ['pending', 'acknowledge', 'delivery']
);
