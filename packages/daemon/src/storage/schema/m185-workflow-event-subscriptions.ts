import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { createWorkflowEventSubscriptionTables } from './workflow-event-subscriptions.ts';

export function runMigration185(db: BunDatabase): void {
  createWorkflowEventSubscriptionTables(db);
}
