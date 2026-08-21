import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type {
  SpaceWorkflow,
  SpaceWorkflowRun,
  WorkflowRunStatus,
  CreateWorkflowRunParams,
  WorkflowRunFailureReason,
} from '@hyperneo/shared';
import { computeDefinitionVersion } from '../../lib/space/workflows/definition-version';
import { SpaceWorkflowDefinitionVersionRepository } from './space-workflow-definition-version-repository';
import type { SQLiteValue } from '../types';
import { assertValidTransition } from '../../lib/space/runtime/workflow-run-status-machine';
import { Logger } from '../../lib/logger';

const log = new Logger('space-workflow-run-repository');

export interface UpdateWorkflowRunParams {
  title?: string;
  description?: string;
  status?: WorkflowRunStatus;
  failureReason?: WorkflowRunFailureReason | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export class SpaceWorkflowRunRepository {
  constructor(private db: BunDatabase) {}

  createRun(params: CreateWorkflowRunParams): SpaceWorkflowRun {
    return this.insertRun(params, null);
  }

  createPinnedRun(
    params: CreateWorkflowRunParams & { rawWorkflow: SpaceWorkflow }
  ): SpaceWorkflowRun {
    if (params.rawWorkflow.id !== params.workflowId) {
      throw new Error('Pinned workflow id does not match the run workflow id');
    }
    if (params.rawWorkflow.spaceId !== params.spaceId) {
      throw new Error('Pinned workflow space does not match the run space');
    }

    const { versionHash, payload } = computeDefinitionVersion(params.rawWorkflow);
    const appendVersion = new SpaceWorkflowDefinitionVersionRepository(this.db);
    return this.db.transaction(() => {
      appendVersion.appendVersion({
        workflowId: params.workflowId,
        spaceId: params.spaceId,
        versionHash,
        payload,
        source: 'run_create',
        createdAt: Date.now(),
      });
      return this.insertRun(params, versionHash);
    })();
  }

  listPinnableRuns(): Array<{ id: string; workflowId: string; spaceId: string }> {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.workflow_id, r.space_id FROM space_workflow_runs r
         WHERE r.definition_version IS NULL
           AND EXISTS (
             SELECT 1 FROM space_tasks t
             WHERE t.workflow_run_id = r.id AND t.archived_at IS NULL
           )
         ORDER BY r.created_at ASC, r.rowid ASC`
      )
      .all() as Array<{ id: string; workflow_id: string; space_id: string }>;
    return rows.map((r) => ({
      id: r.id,
      workflowId: r.workflow_id,
      spaceId: r.space_id,
    }));
  }

  pinExistingRun(runId: string, rawWorkflow: SpaceWorkflow): boolean {
    const { versionHash, payload } = computeDefinitionVersion(rawWorkflow);
    const appendVersion = new SpaceWorkflowDefinitionVersionRepository(this.db);
    return this.db.transaction(() => {
      appendVersion.appendVersion({
        workflowId: rawWorkflow.id,
        spaceId: rawWorkflow.spaceId,
        versionHash,
        payload,
        source: 'backfill',
        createdAt: Date.now(),
      });
      const result = this.db
        .prepare(
          `UPDATE space_workflow_runs SET definition_version = ?
           WHERE id = ? AND definition_version IS NULL`
        )
        .run(versionHash, runId);
      return result.changes > 0;
    })();
  }

  backfillDefinitionPins(loadWorkflow: (workflowId: string) => SpaceWorkflow | null): number {
    let count = 0;
    for (const run of this.listPinnableRuns()) {
      try {
        const workflow = loadWorkflow(run.workflowId);
        if (!workflow) continue;
        if (this.pinExistingRun(run.id, workflow)) count += 1;
      } catch (err) {
        log.warn(`backfillDefinitionPins: skipped run ${run.id} (non-fatal):`, err);
      }
    }
    return count;
  }

  private insertRun(
    params: CreateWorkflowRunParams,
    definitionVersion: string | null
  ): SpaceWorkflowRun {
    const id = generateUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO space_workflow_runs
           (id, space_id, workflow_id, definition_version, title, description, status,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.workflowId,
        definitionVersion,
        params.title,
        params.description ?? '',
        'pending',
        now,
        now
      );

    return this.getRun(id)!;
  }

  getRun(id: string): SpaceWorkflowRun | null {
    const stmt = this.db.prepare(`SELECT * FROM space_workflow_runs WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToRun(row);
  }

  getRunsByIds(ids: string[]): SpaceWorkflowRun[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM space_workflow_runs WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRun(row));
  }

  listBySpace(spaceId: string): SpaceWorkflowRun[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_workflow_runs WHERE space_id = ? ORDER BY created_at DESC`
    );
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  listByWorkflow(workflowId: string): SpaceWorkflowRun[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC`
    );
    const rows = stmt.all(workflowId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  getActiveRuns(spaceId: string): SpaceWorkflowRun[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_workflow_runs WHERE space_id = ? AND status = 'in_progress' ORDER BY created_at ASC`
    );
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  getRehydratableRuns(spaceId: string): SpaceWorkflowRun[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_workflow_runs WHERE space_id = ? AND status IN ('in_progress', 'blocked') ORDER BY created_at ASC`
    );
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  updateRun(id: string, params: UpdateWorkflowRunParams): SpaceWorkflowRun | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.title !== undefined) {
      fields.push('title = ?');
      values.push(params.title);
    }
    if (params.description !== undefined) {
      fields.push('description = ?');
      values.push(params.description);
    }
    if (params.status !== undefined) {
      fields.push('status = ?');
      values.push(params.status);

      if (params.status === 'done' || params.status === 'cancelled') {
        fields.push('completed_at = ?');
        values.push(Date.now());
      } else if (params.status === 'in_progress') {
        fields.push('started_at = ?');
        values.push(Date.now());
        if (params.completedAt === undefined) {
          fields.push('completed_at = ?');
          values.push(null);
        }
      }
    }
    if (params.failureReason !== undefined) {
      fields.push('failure_reason = ?');
      values.push(params.failureReason);
    }
    if (params.startedAt !== undefined) {
      fields.push('started_at = ?');
      values.push(params.startedAt ?? null);
    }
    if (params.completedAt !== undefined) {
      fields.push('completed_at = ?');
      values.push(params.completedAt ?? null);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      const stmt = this.db.prepare(
        `UPDATE space_workflow_runs SET ${fields.join(', ')} WHERE id = ?`
      );
      stmt.run(...values);
    }

    return this.getRun(id);
  }

  updateStatusUnchecked(id: string, status: WorkflowRunStatus): SpaceWorkflowRun | null {
    return this.updateRun(id, { status });
  }

  transitionStatus(id: string, to: WorkflowRunStatus): SpaceWorkflowRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`WorkflowRun not found: ${id}`);
    assertValidTransition(run.status, to, id);
    const updated = this.updateRun(id, { status: to })!;
    return updated;
  }

  casRunStatus(
    id: string,
    expected: WorkflowRunStatus | readonly WorkflowRunStatus[],
    next: WorkflowRunStatus
  ): 'won' | 'superseded' {
    const expectedStatuses = Array.isArray(expected) ? [...expected] : [expected];
    if (expectedStatuses.length === 0) return 'superseded';
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `UPDATE space_workflow_runs SET status = ? WHERE id = ? AND status IN (${placeholders})`
      )
      .run(next, id, ...expectedStatuses);
    return result.changes > 0 ? 'won' : 'superseded';
  }

  deleteRun(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM space_workflow_runs WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteByWorkflowId(workflowId: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM space_workflow_runs
         WHERE workflow_id = ?
           AND EXISTS (
             SELECT 1 FROM space_tasks t WHERE t.workflow_run_id = space_workflow_runs.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM space_tasks t
             WHERE t.workflow_run_id = space_workflow_runs.id AND t.archived_at IS NULL
           )`
      )
      .run(workflowId);
    return result.changes;
  }

  private rowToRun(row: Record<string, unknown>): SpaceWorkflowRun {
    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      workflowId: row.workflow_id as string,
      definitionVersion: (row.definition_version as string | null) ?? null,
      title: row.title as string,
      description: (row.description as string | null) ?? undefined,
      status: row.status as WorkflowRunStatus,
      failureReason: (row.failure_reason as WorkflowRunFailureReason | null) ?? undefined,
      createdAt: row.created_at as number,
      startedAt: (row.started_at as number | null) ?? null,
      updatedAt: row.updated_at as number,
      completedAt: (row.completed_at as number | null) ?? null,
    };
  }
}
