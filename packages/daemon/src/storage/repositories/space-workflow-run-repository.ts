/**
 * Space Workflow Run Repository
 *
 * Repository for SpaceWorkflowRun CRUD operations.
 */

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

  /**
   * Create a new workflow run
   */
  createRun(params: CreateWorkflowRunParams): SpaceWorkflowRun {
    return this.insertRun(params, null);
  }

  /**
   * Atomically append the immutable definition snapshot and create a run pinned to it.
   * Production run creation must use this method; createRun remains for legacy/test fixtures.
   */
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

  /**
   * List unpinned runs that are still executable — rows that pre-date Phase-1 pinning (plus
   * any whose head was deleted before backfill) AND that have at least one non-archived
   * task. A run whose tasks are all archived is a tombstone, so the predicate is
   * "EXISTS a non-archived task" rather than strictly "the canonical task is non-archived"
   * — a run with a live canonical task plus archived duplicates still qualifies. The
   * startup backfill pins these so the read cutover can resolve them through an immutable
   * version instead of the mutable head. Fully-archived (tombstoned) runs are excluded:
   * they can never be executed again, so pinning them only burns startup work and creates
   * unexecutable pins (RFC §4/§11 scope the upgrade backfill to non-archived runs).
   */
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

  /**
   * Atomically append the immutable definition snapshot and pin an EXISTING run to it.
   * The startup backfill uses this for runs that pre-date creation-time pinning. Mirrors
   * `createPinnedRun` but UPDATEs an existing row instead of inserting.
   *
   * Idempotent: `appendVersion` is `INSERT OR IGNORE` and the stamp carries a
   * `WHERE definition_version IS NULL` guard, so re-running on an already-pinned run is a
   * no-op and the version history never duplicates. Returns false if the run was already
   * pinned (or no longer exists).
   */
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
      // Stamp only the definition pin — do NOT bump updated_at. This is an internal
      // migration with no run activity; bumping it would distort UI recency ordering of
      // terminal runs (VisualWorkflowEditor sorts by updated_at), surfacing an older
      // backfilled run over the genuinely latest one.
      const result = this.db
        .prepare(
          `UPDATE space_workflow_runs SET definition_version = ?
           WHERE id = ? AND definition_version IS NULL`
        )
        .run(versionHash, runId);
      return result.changes > 0;
    })();
  }

  /**
   * Pin every existing run that lacks a creation-time definition version to its current
   * head (RFC §4 Phase 1 read-cutover backfill). `loadWorkflow` resolves a workflow id to
   * its RAW persisted definition — the repo-level read, pre-sanitization, the same input
   * `createPinnedRun` pins — so a run is stamped with the version of exactly what it
   * executes today.
   *
   * Content-neutral by construction: at cutover time each run's pin equals its current
   * head, so resolving through the pin changes nothing for in-flight runs. Runs whose head
   * has been deleted are skipped (left null → the read-cutover fallback returns null,
   * matching today's behavior). Idempotent and per-run guarded: a single malformed row
   * must not propagate and prevent daemon startup.
   */
  backfillDefinitionPins(loadWorkflow: (workflowId: string) => SpaceWorkflow | null): number {
    let count = 0;
    for (const run of this.listPinnableRuns()) {
      try {
        const workflow = loadWorkflow(run.workflowId);
        if (!workflow) continue; // deleted head → leave unpinned (read-cutover fallback)
        // pinExistingRun only stamps the pin; the startup backfill sweep runs after this.
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
   * Batch-fetch runs by id in a single round-trip. Missing ids are omitted.
   * Used to collapse N+1 lookups in EvolutionScopeService.buildPreflightContext.
   */
  getRunsByIds(ids: string[]): SpaceWorkflowRun[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM space_workflow_runs WHERE id IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.rowToRun(row));
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
   * so that runs awaiting review get an executor reloaded on restart.
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
   * Delete every TOMBSTONED run that belongs to a given workflow — i.e. runs
   * whose tasks are all archived (the non-reopenable tombstone, RFC §3.1/§4 #3).
   *
   * Needed because migration 60 rebuilt `space_workflow_runs` without an
   * `ON DELETE CASCADE` FK on `workflow_id`, so callers that remove a workflow
   * must explicitly clean up its runs to avoid orphans.
   *
   * Deletion-safe (RFC §4 #3): runs with any non-archived task are PROTECTED —
   * they may still execute (a `done`/`cancelled` run reopens). Only runs with no
   * non-archived task are deleted. Callers that need to know whether live runs
   * block full cleanup should check `SpaceWorkflowRepository.hasNonArchivedRuns`
   * first; this method silently leaves protected runs in place as defense in
   * depth (it never strands an executable run regardless of caller).
   *
   * @returns The number of rows deleted (never includes protected runs).
   */
  deleteByWorkflowId(workflowId: string): number {
    // Delete every run of this workflow EXCEPT those that still have a
    // non-archived task (RFC §4 #3 — such a run is executable: done/cancelled
    // reopen, so only an archived task is a non-reopenable tombstone). Compute
    // the protected run-id set first and delete by `NOT IN`, rather than a
    // correlated `NOT EXISTS` against the target table: SQLite does not
    // reliably correlate a DELETE's WHERE-subquery against the row being
    // deleted, so the correlation form over-deletes. The `workflow_run_id IS
    // NOT NULL` guard keeps `NOT IN` NULL-safe (a NULL in the set would
    // otherwise suppress every deletion).
    const result = this.db
      .prepare(
        `DELETE FROM space_workflow_runs
         WHERE workflow_id = ?
           AND id NOT IN (
             SELECT t.workflow_run_id FROM space_tasks t
             WHERE t.archived_at IS NULL AND t.workflow_run_id IS NOT NULL
           )`
      )
      .run(workflowId);
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
