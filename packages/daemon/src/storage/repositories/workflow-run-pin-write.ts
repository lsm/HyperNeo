import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { ReactiveDatabase } from '../reactive-database.ts';
import type { Database } from '../sqlite-compat.ts';
import { SpaceWorkflowDefinitionVersionRepository } from './space-workflow-definition-version-repository.ts';

type WorkflowRunPin = {
  runId: string;
  workflowId: string;
  spaceId: string;
  versionHash: string;
  payload: string;
};

class WorkflowRunPinWriter {
  constructor(
    private readonly db: Database,
    private readonly changes?: ReactiveDatabase
  ) {}

  pin(pin: WorkflowRunPin): boolean {
    return this.persist(pin, true);
  }

  migrateSnapshot(pin: WorkflowRunPin): boolean {
    return this.persist(pin, false);
  }

  private persist(pin: WorkflowRunPin, onlyUnpinned: boolean): boolean {
    new SpaceWorkflowDefinitionVersionRepository(this.db).appendVersion({
      workflowId: pin.workflowId,
      spaceId: pin.spaceId,
      versionHash: pin.versionHash,
      payload: pin.payload,
      source: 'backfill',
      createdAt: Date.now(),
    });
    const result = this.db
      .prepare(
        `UPDATE space_workflow_runs SET definition_version = ?
           WHERE id = ?${onlyUnpinned ? ' AND definition_version IS NULL' : ''}`
      )
      .run(pin.versionHash, pin.runId);
    this.changes?.notifyChange('space_workflow_definition_versions', { spaceId: pin.spaceId });
    if (result.changes > 0)
      this.changes?.notifyChange('space_workflow_runs', { spaceId: pin.spaceId });
    return result.changes > 0;
  }
}

export const workflowRunPinWrites = defineRepositoryOp(
  'workflow.run.pin.write',
  'write',
  WorkflowRunPinWriter,
  ['pin', 'migrateSnapshot'] as const
);
