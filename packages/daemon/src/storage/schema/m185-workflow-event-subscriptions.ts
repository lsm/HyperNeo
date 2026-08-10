/**
 * Migration 185 — Persist workflow-run event subscriptions.
 *
 * PR 5 of the external-event subscription refactor. Principle: anything
 * in-memory must be derived from durable state. Until now, `SpaceRuntime`
 * kept workflow external-event subscriptions only in its in-memory `TopicTrie`
 * via `registerSubscription(...)`; dynamic/ad-hoc subscriptions (a coder
 * subscribing to its own PR) were the trie's only copy and were lost on daemon
 * restart.
 *
 * This migration creates `space_workflow_event_subscriptions` as the single
 * durable source of truth for all runtime subscriptions (both `static`
 * template interests and `dynamic` agent-registered interests). The trie
 * becomes a pure derived index, rebuilt from this table on rehydrate.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`);
 * new databases receive the same schema from `createTables()`.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { createWorkflowEventSubscriptionTables } from './workflow-event-subscriptions';

export function runMigration185(db: BunDatabase): void {
  createWorkflowEventSubscriptionTables(db);
}
