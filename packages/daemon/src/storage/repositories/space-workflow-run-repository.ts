/**
 * Space Workflow Run Repository
 *
 * Repository for SpaceWorkflowRun CRUD operations.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import type {
  SpaceWorkflowRun,
  WorkflowRunStatus,
  CreateWorkflowRunParams,
  WorkflowRunFailureReason,
} from '@hyperneo/shared';
import type { SQLiteValue } from '../types';
import { assertValidTransition } from '../../lib/space/runtime/workflow-run-status-machine';
import type { GateOpenStateRepository } from './gate-open-state-repository';

export interface UpdateWorkflowRunParams {
  title?: string;
  description?: string;
  status?: WorkflowRunStatus;
  failureReason?: WorkflowRunFailureReason | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

export class SpaceWorkflowRunRepository {
  constructor(
    private db: BunDatabase,
    private gateOpenStateRepo?: GateOpenStateRepository
  ) {}

  /**
   * Create a new workflow run
   */
  createRun(params: CreateWorkflowRunParams): SpaceWorkflowRun {
    const id = generateUUID();
    const now = Date.now();

    const stmt = this.db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      params.spaceId,
      params.workflowId,
      params.title,
      params.description ?? '',
      'pending',
      now,
      now
    );

    return this.getRun(id)!;
  }

  /**
   * Get a workflow run by ID
   */
  getRun(id: string): SpaceWorkflowRun | null {
    const stmt = this.db.prepare(`SELECT * FROM space_workflow_runs WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToRun(row);
  }

  /**
   * List workflow runs for a space
   */
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

  /**
   * List in-progress workflow runs for a space.
   *
   * Only `in_progress` runs are returned — `pending` is a transient state that
   * exists only briefly inside `startWorkflowRun` between `createRun` and the
   * `updateStatus('in_progress')` call. Including `pending` here would cause
   * a run that failed mid-creation to be rehydrated without a task and silently
   * loop forever in the executor map.
   */
  getActiveRuns(spaceId: string): SpaceWorkflowRun[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_workflow_runs WHERE space_id = ? AND status = 'in_progress' ORDER BY created_at ASC`
    );
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  /**
   * List runs that need an executor on startup: in_progress and blocked.
   *
   * This superset of getActiveRuns() is used exclusively by rehydrateExecutors()
   * so that runs blocked at a human gate get an executor reloaded on restart.
   *
   * `pending` is still excluded for the same reason as in getActiveRuns().
   */
  getRehydratableRuns(spaceId: string): SpaceWorkflowRun[] {
    const stmt = this.db.prepare(
      `SELECT * FROM space_workflow_runs WHERE space_id = ? AND status IN ('in_progress', 'blocked') ORDER BY created_at ASC`
    );
    const rows = stmt.all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  /**
   * Update a workflow run with partial updates
   */
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

  /**
   * Update only the status of a run, bypassing lifecycle transition guards.
   *
   * Intended for test fixtures and internal helpers only — use transitionStatus()
   * for all production code that changes run status.
   */
  updateStatusUnchecked(id: string, status: WorkflowRunStatus): SpaceWorkflowRun | null {
    return this.updateRun(id, { status });
  }

  /**
   * Atomically validate and apply a lifecycle status transition.
   *
   * Reads the current status from the DB, validates the requested transition
   * against the WorkflowRunStatusMachine, and persists the new status only
   * when the transition is allowed.
   *
   * @returns The updated run on success.
   * @throws {Error} when the run is not found.
   * @throws {Error} when the transition is not permitted by the lifecycle rules.
   */
  transitionStatus(id: string, to: WorkflowRunStatus): SpaceWorkflowRun {
    const run = this.getRun(id);
    if (!run) throw new Error(`WorkflowRun not found: ${id}`);
    assertValidTransition(run.status, to, id);
    const updated = this.updateRun(id, { status: to })!;

    // Clear persisted gate-open state when transitioning to terminal OR blocked
    // status. The blocked transition MUST clear the cache so that
    // approveGate's rejection branch (which does not call fireGateChanged)
    // cannot leave a stale `open=true` row that causes future deliverMessage
    // calls to bypass the now-rejected gate at channel-router.ts:620-624.
    if (this.gateOpenStateRepo && (to === 'done' || to === 'cancelled' || to === 'blocked')) {
      this.gateOpenStateRepo.clearOpenedByRun(id);
    }

    return updated;
  }

  /**
   * Delete a workflow run by ID
   */
  deleteRun(id: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM space_workflow_runs WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete every run that belongs to a given workflow.
   *
   * Needed because migration 60 rebuilt `space_workflow_runs` without an
   * `ON DELETE CASCADE` FK on `workflow_id`, so callers that remove a workflow
   * must explicitly clean up its runs to avoid orphans.
   *
   * @returns The number of rows deleted.
   */
  deleteByWorkflowId(workflowId: string): number {
    const stmt = this.db.prepare(`DELETE FROM space_workflow_runs WHERE workflow_id = ?`);
    const result = stmt.run(workflowId);
    return result.changes;
  }

  /**
   * Convert a database row to a SpaceWorkflowRun object
   */
  private rowToRun(row: Record<string, unknown>): SpaceWorkflowRun {
    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      workflowId: row.workflow_id as string,
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
