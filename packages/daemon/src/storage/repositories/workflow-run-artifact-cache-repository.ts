/**
 * Workflow Run Artifact Cache Repository
 *
 * Stores JSON-serialised results of the expensive git subprocess calls that
 * back the TaskArtifactsPanel — gate artifacts (uncommitted numstat), commit
 * log (between diff-base and HEAD), and per-file diffs. Rows are keyed by
 * `(run_id, task_id, cache_key)` and upserted by background job handlers in
 * `packages/daemon/src/lib/job-handlers/space-workflow-run-artifact.handler.ts`.
 *
 * The frontend learns about new rows via the `space.artifactCache.updated`
 * InternalEventBus<DaemonInternalEventMap> event emitted from the job handlers — there is no LiveQuery on
 * this table, so the repo does not notify the `ReactiveDatabase`.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { generateUUID } from '@hyperneo/shared';
import { Logger } from '../../lib/logger';

const log = new Logger('workflow-run-artifact-cache-repo');

export type ArtifactCacheStatus = 'ok' | 'syncing' | 'error';

export interface WorkflowRunArtifactCacheRecord {
  id: string;
  runId: string;
  /** Empty string means "no specific task" (run-level cache entry). */
  taskId: string;
  cacheKey: string;
  status: ArtifactCacheStatus;
  data: Record<string, unknown>;
  error: string | null;
  syncedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface CacheUpsertParams {
  runId: string;
  taskId?: string;
  cacheKey: string;
  status: ArtifactCacheStatus;
  data: Record<string, unknown>;
  error?: string | null;
  /** Wall-clock time the underlying git command finished; defaults to now. */
  syncedAt?: number;
}

export class WorkflowRunArtifactCacheRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Upsert a cache entry. On conflict (same run + task + cache_key) the data,
   * status, error, synced_at, and updated_at fields are overwritten.
   */
  upsert(params: CacheUpsertParams): WorkflowRunArtifactCacheRecord {
    const now = Date.now();
    const taskId = params.taskId ?? '';
    const syncedAt = params.syncedAt ?? now;
    const row = this.db
      .prepare(
        `INSERT INTO workflow_run_artifact_cache
					(id, run_id, task_id, cache_key, status, data, error, synced_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(run_id, task_id, cache_key) DO UPDATE SET
				   status = excluded.status,
				   data = excluded.data,
				   error = excluded.error,
				   synced_at = excluded.synced_at,
				   updated_at = excluded.updated_at
				 RETURNING *`
      )
      .get(
        generateUUID(),
        params.runId,
        taskId,
        params.cacheKey,
        params.status,
        JSON.stringify(params.data),
        params.error ?? null,
        syncedAt,
        now,
        now
      ) as Record<string, unknown>;

    return this.rowToRecord(row)!;
  }

  /** Get a single cache entry by composite key, or null. */
  get(runId: string, cacheKey: string, taskId?: string): WorkflowRunArtifactCacheRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_run_artifact_cache
				 WHERE run_id = ? AND task_id = ? AND cache_key = ?`
      )
      .get(runId, taskId ?? '', cacheKey) as Record<string, unknown> | undefined;

    return row ? this.rowToRecord(row) : null;
  }

  /** List all cache entries for a workflow run (all tasks, all keys). */
  listByRun(runId: string): WorkflowRunArtifactCacheRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_run_artifact_cache WHERE run_id = ?
				 ORDER BY created_at ASC, id ASC`
      )
      .all(runId) as Record<string, unknown>[];
    return rows
      .map((r) => this.rowToRecord(r))
      .filter((r): r is WorkflowRunArtifactCacheRecord => r !== null);
  }

  /** Delete all cache entries for a workflow run. Returns the number deleted. */
  deleteByRun(runId: string): number {
    const result = this.db
      .prepare('DELETE FROM workflow_run_artifact_cache WHERE run_id = ?')
      .run(runId);
    return result.changes;
  }

  /**
   * Delete cache entries for a (run, task) pair. Used when a worktree is
   * known to have changed and the cache should be invalidated.
   */
  deleteByRunTask(runId: string, taskId: string): number {
    const result = this.db
      .prepare('DELETE FROM workflow_run_artifact_cache WHERE run_id = ? AND task_id = ?')
      .run(runId, taskId);
    return result.changes;
  }

  private rowToRecord(row: Record<string, unknown>): WorkflowRunArtifactCacheRecord | null {
    const raw = row.data as string;
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      return {
        id: row.id as string,
        runId: row.run_id as string,
        taskId: (row.task_id as string) ?? '',
        cacheKey: row.cache_key as string,
        status: row.status as ArtifactCacheStatus,
        data,
        error: (row.error as string | null) ?? null,
        syncedAt: row.synced_at as number,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
    } catch (err) {
      log.error(
        `Corrupted artifact-cache data for id=${row.id} — ` +
          `JSON.parse failed (${err instanceof Error ? err.message : String(err)})`
      );
      return null;
    }
  }
}
