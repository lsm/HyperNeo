import { SpaceWorkflowManager } from '../../lib/workflows/workflow-manager.ts';
import { WorkflowDeletionBlockedError } from '../../lib/workflows/workflow-validation-error.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { SpaceWorkflowRepository } from './space-workflow-repository.ts';

export type WorkflowDeleteResult =
  | { deleted: boolean }
  | { blocked: { message: string; workflowId: string } };

class WorkflowDeleteWriter {
  constructor(
    private readonly db: Database,
    private readonly changes?: ReactiveDatabase
  ) {}

  delete(id: string): WorkflowDeleteResult {
    try {
      const deleted = new SpaceWorkflowManager(new SpaceWorkflowRepository(this.db)).deleteWorkflow(
        id
      );
      if (deleted) {
        this.changes?.notifyChange('space_workflows');
        this.changes?.notifyChange('space_workflow_nodes');
      }
      return { deleted };
    } catch (error) {
      if (!(error instanceof WorkflowDeletionBlockedError)) throw error;
      return { blocked: { message: error.message, workflowId: error.workflowId } };
    }
  }
}

export const workflowDeleteWrites = defineRepositoryOp(
  'workflow.delete.write',
  'write',
  WorkflowDeleteWriter,
  ['delete'] as const
);
