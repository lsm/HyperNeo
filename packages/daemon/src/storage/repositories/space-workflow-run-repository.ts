import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  SpaceWorkflow,
  SpaceWorkflowRun,
  SpaceTaskStatus,
  WorkflowRunStatus,
  CreateWorkflowRunParams,
  WorkflowRunFailureReason,
} from '@hyperneo/shared';
import {
  computeDefinitionVersion,
  verifyDefinitionVersion,
} from '../../lib/space/workflows/definition-version.ts';
import {
  withRunTemplateSnapshots,
  type AgentTemplateResolver,
  type AgentTemplateResolverFactory,
} from '../../lib/space/workflows/run-template-snapshot.ts';
import {
  buildPlanRunSnapshotMigration,
  isRunSnapshotMigrationSkip,
  type RunSnapshotMigrationPlan,
} from '../../lib/space/workflows/plan-run-snapshot-migration.ts';
import { SpaceWorkflowDefinitionVersionRepository } from './space-workflow-definition-version-repository.ts';
import type { SQLiteValue } from '../types.ts';
import { assertValidTransition } from '../../lib/space/runtime/workflow-run-status-machine.ts';
import { Logger } from '../../lib/logger.ts';

const log = new Logger('space-workflow-run-repository');

export interface UpdateWorkflowRunParams {
  title?: string;
  description?: string;
  status?: WorkflowRunStatus;
  failureReason?: WorkflowRunFailureReason | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export const TERMINAL_RUN_RECONCILE_SETTLED_TASK_STATUSES: readonly SpaceTaskStatus[] = [
  'done',
  'review',
  'cancelled',
  'approved',
  'blocked',
  'stopped',
];

const CANCELLED_RUN_RECONCILE_SETTLEABLE_TASK_STATUSES: readonly SpaceTaskStatus[] = [
  'open',
  'in_progress',
  'review',
  'approved',
  'blocked',
  'rate_limited',
  'usage_limited',
  'stopped',
];

export class SpaceWorkflowRunRepository {
  constructor(private db: BunDatabase) {}

  createRun(params: CreateWorkflowRunParams): SpaceWorkflowRun {
    return this.insertRun(params, null);
  }

  createPinnedRun(
    params: CreateWorkflowRunParams & { rawWorkflow: SpaceWorkflow },
    resolveTemplate?: AgentTemplateResolver
  ): SpaceWorkflowRun {
    if (params.rawWorkflow.id !== params.workflowId) {
      throw new Error('Pinned workflow id does not match the run workflow id');
    }
    if (params.rawWorkflow.spaceId !== params.spaceId) {
      throw new Error('Pinned workflow space does not match the run space');
    }

    const pinnedWorkflow = resolveTemplate
      ? withRunTemplateSnapshots(params.rawWorkflow, resolveTemplate)
      : params.rawWorkflow;
    const { versionHash, payload } = computeDefinitionVersion(pinnedWorkflow);
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
           AND (
             NOT EXISTS (
               SELECT 1 FROM space_tasks t WHERE t.workflow_run_id = r.id
             )
             OR EXISTS (
               SELECT 1 FROM space_tasks t
               WHERE t.workflow_run_id = r.id AND t.archived_at IS NULL
             )
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

  pinExistingRun(
    runId: string,
    rawWorkflow: SpaceWorkflow,
    resolveTemplate?: AgentTemplateResolver
  ): boolean {
    const pinnedWorkflow = resolveTemplate
      ? withRunTemplateSnapshots(rawWorkflow, resolveTemplate)
      : rawWorkflow;
    const { versionHash, payload } = computeDefinitionVersion(pinnedWorkflow);
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

  listSnapshotlessPinnedRuns(): Array<{
    id: string;
    workflowId: string;
    spaceId: string;
    payload: string;
    versionHash: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.workflow_id, r.space_id, r.definition_version AS version_hash, v.payload
         FROM space_workflow_runs r
         JOIN space_workflow_definition_versions v
           ON v.workflow_id = r.workflow_id AND v.version_hash = r.definition_version
         WHERE r.definition_version IS NOT NULL
           AND CASE
                 WHEN json_valid(v.payload)
                   THEN json_extract(v.payload, '$.templateSnapshots') IS NULL
                 ELSE 1
               END
           AND (
             NOT EXISTS (
               SELECT 1 FROM space_tasks t WHERE t.workflow_run_id = r.id
             )
             OR EXISTS (
               SELECT 1 FROM space_tasks t
               WHERE t.workflow_run_id = r.id AND t.archived_at IS NULL
             )
           )
         ORDER BY r.created_at ASC, r.rowid ASC`
      )
      .all() as Array<{
      id: string;
      workflow_id: string;
      space_id: string;
      payload: string;
      version_hash: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      workflowId: r.workflow_id,
      spaceId: r.space_id,
      payload: r.payload,
      versionHash: r.version_hash,
    }));
  }

  migrateSnapshotlessPins(
    resolveTemplateFor: AgentTemplateResolverFactory,
    loadWorkflow: (workflowId: string) => SpaceWorkflow | null
  ): number {
    let count = 0;
    for (const run of this.listSnapshotlessPinnedRuns()) {
      try {
        const plan = buildPlanRunSnapshotMigration({
          verifyVersion: verifyDefinitionVersion,
          loadWorkflow,
          resolveTemplate: resolveTemplateFor(run.spaceId),
          computeVersion: computeDefinitionVersion,
        });
        const outcome = plan(run);
        if (isRunSnapshotMigrationSkip(outcome)) {
          log.warn(`migrateSnapshotlessPins: ${outcome.message}`);
          continue;
        }
        if (outcome.source === 'live') {
          log.warn(
            `migrateSnapshotlessPins: run ${outcome.runId} had an unverifiable pin; ` +
              `snapshotting the live definition it was already resolving`
          );
        }
        if (this.applyRunSnapshotMigration(outcome)) count += 1;
      } catch (err) {
        log.warn(`migrateSnapshotlessPins: skipped run ${run.id} (non-fatal):`, err);
      }
    }
    return count;
  }

  private applyRunSnapshotMigration(plan: RunSnapshotMigrationPlan): boolean {
    const appendVersion = new SpaceWorkflowDefinitionVersionRepository(this.db);
    const migrated = this.db.transaction(() => {
      appendVersion.appendVersion({
        workflowId: plan.workflowId,
        spaceId: plan.spaceId,
        versionHash: plan.versionHash,
        payload: plan.payload,
        source: 'backfill',
        createdAt: Date.now(),
      });
      return this.db
        .prepare(`UPDATE space_workflow_runs SET definition_version = ? WHERE id = ?`)
        .run(plan.versionHash, plan.runId).changes;
    })();
    return migrated > 0;
  }

  backfillDefinitionPins(
    loadWorkflow: (workflowId: string) => SpaceWorkflow | null,
    resolveTemplateFor?: AgentTemplateResolverFactory
  ): number {
    let count = 0;
    for (const run of this.listPinnableRuns()) {
      try {
        const workflow = loadWorkflow(run.workflowId);
        if (!workflow) continue;
        const resolveTemplate = resolveTemplateFor?.(run.spaceId);
        if (this.pinExistingRun(run.id, workflow, resolveTemplate)) count += 1;
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

  listTerminalRunsNeedingTaskReconciliation(spaceId: string): SpaceWorkflowRun[] {
    const settleable = CANCELLED_RUN_RECONCILE_SETTLEABLE_TASK_STATUSES.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT run.* FROM space_workflow_runs run
       WHERE run.space_id = ?
         AND run.status IN ('done', 'cancelled')
         AND (
           (
             run.status = 'done'
             AND EXISTS (
               SELECT 1 FROM space_tasks t
                WHERE t.workflow_run_id = run.id AND t.status = 'in_progress'
             )
           )
           OR (
             run.status = 'cancelled'
             AND EXISTS (
               SELECT 1 FROM space_tasks t
                WHERE t.workflow_run_id = run.id AND t.status IN (${settleable})
             )
           )
           OR (
             SELECT COUNT(*) FROM space_tasks t
              WHERE t.workflow_run_id = run.id AND t.status != 'archived'
           ) > 1
           OR (
             run.status = 'done'
             AND EXISTS (
               SELECT 1 FROM space_tasks t
                WHERE t.workflow_run_id = run.id AND t.status != 'archived'
             )
             AND EXISTS (
               SELECT 1 FROM workflow_run_artifacts a
                WHERE a.run_id = run.id
                  AND a.artifact_type = 'decision'
                  AND a.updated_at >= (
                    SELECT COALESCE(MAX(t3.reconcile_checked_at), 0) FROM space_tasks t3
                     WHERE t3.workflow_run_id = run.id AND t3.status != 'archived'
                  )
             )
           )
           OR (
             run.status = 'done'
             AND EXISTS (
               SELECT 1 FROM space_tasks t
                WHERE t.workflow_run_id = run.id
                  AND t.status != 'archived'
                  AND (
                    COALESCE(TRIM(t.result), '') = ''
                    OR COALESCE(TRIM(t.reported_summary), '') = ''
                  )
                  AND (
                    t.updated_at >= (
                      SELECT COALESCE(MAX(t3.reconcile_checked_at), 0) FROM space_tasks t3
                       WHERE t3.workflow_run_id = run.id AND t3.status != 'archived'
                    )
                    OR EXISTS (
                      SELECT 1 FROM space_tasks s
                       WHERE s.workflow_run_id = run.id
                         AND s.id != t.id
                         AND s.status != 'archived'
                         AND COALESCE(TRIM(s.result), '') != ''
                         AND s.updated_at >= (
                           SELECT COALESCE(MAX(t4.reconcile_checked_at), 0) FROM space_tasks t4
                            WHERE t4.workflow_run_id = run.id AND t4.status != 'archived'
                         )
                    )
                    OR EXISTS (
                      SELECT 1 FROM node_executions e
                       WHERE e.workflow_run_id = run.id
                         AND e.status = 'idle'
                         AND COALESCE(TRIM(e.result), '') != ''
                         AND e.updated_at >= (
                           SELECT COALESCE(MAX(t5.reconcile_checked_at), 0) FROM space_tasks t5
                            WHERE t5.workflow_run_id = run.id AND t5.status != 'archived'
                         )
                    )
                  )
             )
           )
         )
       ORDER BY run.created_at DESC`
    );
    const rows = stmt.all(spaceId, ...CANCELLED_RUN_RECONCILE_SETTLEABLE_TASK_STATUSES) as Record<
      string,
      unknown
    >[];
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
    const sets = ['status = ?'];
    const values: SQLiteValue[] = [next];
    if (next === 'done' || next === 'cancelled') {
      sets.push('completed_at = ?');
      values.push(Date.now());
    } else if (next === 'in_progress') {
      sets.push('started_at = ?');
      values.push(Date.now());
      sets.push('completed_at = ?');
      values.push(null);
    }
    sets.push('updated_at = ?');
    values.push(Date.now());
    const result = this.db
      .prepare(
        `UPDATE space_workflow_runs SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`
      )
      .run(...values, id, ...expectedStatuses);
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
