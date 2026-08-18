import type { Database as BunDatabase } from '../sqlite-compat';
import { createWorkflowEventSubscriptionTables } from './workflow-event-subscriptions';

export function runMigration185(db: BunDatabase): void {
  createWorkflowEventSubscriptionTables(db);
}
