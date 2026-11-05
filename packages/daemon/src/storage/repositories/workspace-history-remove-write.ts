import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { WorkspaceHistoryRepository } from './workspace-history-repository.ts';

class WorkspaceHistoryRemover {
  constructor(private readonly db: Database) {}

  remove(path: string) {
    return new WorkspaceHistoryRepository(this.db).remove(path);
  }
}

export const workspaceHistoryRemoveWrites = defineRepositoryOp(
  'workspace.history.remove.write',
  'write',
  WorkspaceHistoryRemover,
  ['remove'] as const
);
