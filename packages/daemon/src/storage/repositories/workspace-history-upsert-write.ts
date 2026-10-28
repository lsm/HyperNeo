import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { WorkspaceHistoryRepository } from './workspace-history-repository.ts';

class WorkspaceHistoryUpserter {
  constructor(private readonly db: Database) {}

  upsert(path: string, now: number) {
    return new WorkspaceHistoryRepository(this.db).upsert(path, now);
  }
}

export const workspaceHistoryUpsertWrites = defineRepositoryOp(
  'workspace.history.upsert.write',
  'write',
  WorkspaceHistoryUpserter,
  ['upsert'] as const
);
