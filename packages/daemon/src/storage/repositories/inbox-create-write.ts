import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import { InboxItemRepository, type CreateInboxItemParams } from './inbox-item-repository.ts';

class InboxCreator {
  constructor(
    private readonly db: Database,
    private readonly changes?: ReactiveDatabase
  ) {}

  create(params: CreateInboxItemParams, id: string, now: number) {
    const item = new InboxItemRepository(this.db).createItem(params, id, now);
    this.changes?.notifyChange('inbox_items');
    return item;
  }
}

export const inboxCreateWrites = defineRepositoryOp(
  'github.inbox.create.write',
  'write',
  InboxCreator,
  ['create'] as const
);
