/**
 * Workflow Run Artifact Repository
 *
 * Persistence layer for typed artifacts produced by workflow node executions.
 * Artifacts are keyed by `(run_id, node_id, artifact_type, artifact_key)` and
 * support upsert semantics — writing the same key twice updates the data.
 *
 * Each write calls reactiveDb.notifyChange('workflow_run_artifacts') so that
 * LiveQuery subscriptions push updates to the frontend in real time.
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import type { ReactiveDatabase } from '../reactive-database';
import { Logger } from '../../lib/logger';

const log = new Logger('workflow-run-artifact-repo');

export interface WorkflowRunArtifactRecord {
  id: string;
  runId: string;
  nodeId: string;
  artifactType: string;
  artifactKey: string;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export class WorkflowRunArtifactRepository {
  /** True when any row's data JSON failed to parse in a prior read — the
   * caller (hook engine ctx) fails closed on a possibly-partial snapshot. */
  private lastReadHadCorruptRow: boolean = false;

  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

  /** Whether the most recent list read encountered a corrupt data row. */
  get lastReadWasPartial(): boolean {
    return this.lastReadHadCorruptRow;
  }

  /**
   * Upsert an artifact. On conflict (same run + node + type + key),
   * updates data and updatedAt.
   */
  upsert(params: {
    id: string;
    runId: string;
    nodeId: string;
    artifactType: string;
    artifactKey: string;
    data: Record<string, unknown>;
  }): WorkflowRunArtifactRecord {
    const now = Date.now();
    const row = this.db
      .prepare(
        `INSERT INTO workflow_run_artifacts (id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(run_id, node_id, artifact_type, artifact_key) DO UPDATE SET
				   data = excluded.data, updated_at = excluded.updated_at
				 RETURNING *`
      )
      .get(
        params.id,
        params.runId,
        params.nodeId,
        params.artifactType,
        params.artifactKey,
        JSON.stringify(params.data),
        now,
        now
      ) as Record<string, unknown>;

    this.reactiveDb?.notifyChange('workflow_run_artifacts');

    return this.rowToRecord(row)!;
  }

  /** List artifacts for a run, optionally filtered by nodeId and/or artifactType. */
  listByRun(
    runId: string,
    filters?: {
      nodeId?: string;
      artifactType?: string;
      artifactKeyPrefix?: string;
      /** Bounds the scan on hot paths (e.g. the hook engine's reserved-stamp read). */
      limit?: number;
    }
  ): WorkflowRunArtifactRecord[] {
    this.lastReadHadCorruptRow = false;
    let sql = 'SELECT * FROM workflow_run_artifacts WHERE run_id = ?';
    const params: string[] = [runId];

    if (filters?.nodeId) {
      sql += ' AND node_id = ?';
      params.push(filters.nodeId);
    }
    if (filters?.artifactType) {
      sql += ' AND artifact_type = ?';
      params.push(filters.artifactType);
    }
    if (filters?.artifactKeyPrefix !== undefined) {
      // GLOB (not LIKE) so `_` in the prefix is literal, not a wildcard —
      // the engine's reserved namespace is exactly `__`-prefixed keys.
      sql += ' AND artifact_key GLOB ?';
      params.push(`${filters.artifactKeyPrefix}*`);
    }
    sql += ' ORDER BY created_at ASC';
    if (filters?.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(String(filters.limit));
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows
      .map((r) => this.rowToRecord(r))
      .filter((r): r is WorkflowRunArtifactRecord => r !== null);
  }

  /**
   * The most-recently-updated `limit` artifacts for a run, for hot-path readers
   * (e.g. hook context) that must not load every artifact on each invocation.
   * Bounded at the SQL level (ORDER BY updated_at DESC LIMIT ?).
   */
  listRecentByRun(runId: string, limit: number): WorkflowRunArtifactRecord[] {
    this.lastReadHadCorruptRow = false;
    const rows = this.db
      .prepare(
        'SELECT * FROM workflow_run_artifacts WHERE run_id = ? ORDER BY updated_at DESC LIMIT ?'
      )
      .all(runId, limit) as Record<string, unknown>[];
    return rows
      .map((r) => this.rowToRecord(r))
      .filter((r): r is WorkflowRunArtifactRecord => r !== null);
  }

  /**
   * List artifacts for many runs in a single round-trip. Artifacts are ordered
   * by created_at ASC globally, so grouping by run_id preserves each run's
   * within-run ordering (matching listByRun). Missing run ids contribute no
   * rows. Used to collapse N+1 lookups in buildPreflightContext.
   */
  listByRuns(runIds: string[]): WorkflowRunArtifactRecord[] {
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_run_artifacts WHERE run_id IN (${placeholders}) ORDER BY created_at ASC`
      )
      .all(...runIds) as Record<string, unknown>[];
    return rows
      .map((r) => this.rowToRecord(r))
      .filter((r): r is WorkflowRunArtifactRecord => r !== null);
  }

  /** Delete all artifacts for a workflow run. Returns the number deleted. */
  deleteByRun(runId: string): number {
    const result = this.db
      .prepare('DELETE FROM workflow_run_artifacts WHERE run_id = ?')
      .run(runId);
    if (result.changes > 0) {
      this.reactiveDb?.notifyChange('workflow_run_artifacts');
    }
    return result.changes;
  }

  private rowToRecord(row: Record<string, unknown>): WorkflowRunArtifactRecord | null {
    const raw = row.data as string;
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      return {
        id: row.id as string,
        runId: row.run_id as string,
        nodeId: row.node_id as string,
        artifactType: row.artifact_type as string,
        artifactKey: row.artifact_key as string,
        data,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
    } catch (err) {
      log.error(
        `Corrupted artifact data for id=${row.id} — ` +
          `JSON.parse failed (${err instanceof Error ? err.message : String(err)})`
      );
      this.lastReadHadCorruptRow = true;
      return null;
    }
  }
}
