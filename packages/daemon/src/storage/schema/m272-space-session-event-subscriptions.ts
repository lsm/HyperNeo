import type { Database } from '../sqlite-compat.ts';
import { createSpaceSessionEventSubscriptionTables } from './space-session-event-subscriptions.ts';

export function runMigration272(db: Database): void {
  createSpaceSessionEventSubscriptionTables(db);
}
