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

  /**
   * First-writer-wins claim for a RESERVED identity stamp: insert a new row
   * only if NO row exists for (runId, artifactType, artifactKey) across ANY
   * node. Returns the inserted row, or the pre-existing row (the engine
   * decides whether an existing identity is an idempotent re-stamp or a
   * conflicting one to reject). The unique (run, NODE, type, key) constraint
   * would otherwise let a second node's stamp overwrite within its own key
   * while a first node's row survives — leaving two identity rows; this makes
   * the FIRST stamp authoritative.
   */
  claimIdentityStamp(params: {
    id: string;
    runId: string;
    nodeId: string;
    artifactType: string;
    artifactKey: string;
    data: Record<string, unknown>;
  }):
    | { inserted: true; record: WorkflowRunArtifactRecord }
    | { inserted: false; existing: WorkflowRunArtifactRecord | null } {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT * FROM workflow_run_artifacts
              WHERE run_id = ? AND artifact_type = ? AND artifact_key = ?
              ORDER BY created_at ASC LIMIT 1`
        )
        .get(params.runId, params.artifactType, params.artifactKey) as
        | Record<string, unknown>
        | undefined;
      if (existing) {
        return { kind: 'existing' as const, row: existing };
      }
      const now = Date.now();
      const row = this.db
        .prepare(
          `INSERT INTO workflow_run_artifacts
             (id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      return { kind: 'inserted' as const, row };
    });
    const result = tx();
    if (result.kind === 'inserted') {
      // Notify like every other artifact write — live queries driving the
      // run artifact list / timeline must see the first identity stamp.
      this.reactiveDb?.notifyChange('workflow_run_artifacts');
      return { inserted: true, record: this.rowToRecord(result.row)! };
    }
    return { inserted: false, existing: this.rowToRecord(result.row) };
  }

  /**
   * Verified identity REPLACEMENT: delete every row for (runId, type, key)
   * and insert the new one, in one transaction. The caller (the engine) only
   * invokes this when the hook has verified the prior identity is retired
   * (pr_ready's swap check confirms the previously stamped PR is CLOSED) —
   * the claim's first-writer-wins protection still blocks unverified swaps.
   *
   * CAS on the PRIOR stamp: pass the row id of the identity the caller
   * observed and verified (`expectedPriorId`). Two concurrent replacements
   * can both verify the SAME closed prior stamp before either commits — the
   * second would then unconditionally delete the FIRST's freshly-installed
   * stamp and install its own, leaving both callers believing they set the
   * run's identity. With the CAS, the loser observes the row has changed and
   * refuses, so exactly one replacement wins and the run keeps a single
   * authoritative PR identity.
   */
  replaceIdentityStamp(params: {
    id: string;
    runId: string;
    nodeId: string;
    artifactType: string;
    artifactKey: string;
    data: Record<string, unknown>;
    /** Row id of the prior identity the caller verified; the replacement
     * proceeds only when the current authoritative row is still that one. */
    expectedPriorId?: string;
  }): boolean {
    const tx = this.db.transaction(() => {
      if (params.expectedPriorId !== undefined) {
        const current = this.db
          .prepare(
            `SELECT id FROM workflow_run_artifacts
              WHERE run_id = ? AND artifact_type = ? AND artifact_key = ?
              ORDER BY created_at ASC LIMIT 1`
          )
          .get(params.runId, params.artifactType, params.artifactKey) as { id: string } | undefined;
        if (!current || current.id !== params.expectedPriorId) {
          throw new Error(
            `identity stamp CAS failed: prior row changed (expected ${params.expectedPriorId}, got ${current?.id ?? 'none'})`
          );
        }
      }
      this.db
        .prepare(
          `DELETE FROM workflow_run_artifacts
            WHERE run_id = ? AND artifact_type = ? AND artifact_key = ?`
        )
        .run(params.runId, params.artifactType, params.artifactKey);
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO workflow_run_artifacts
             (id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.id,
          params.runId,
          params.nodeId,
          params.artifactType,
          params.artifactKey,
          JSON.stringify(params.data),
          now,
          now
        );
    });
    try {
      tx();
      this.reactiveDb?.notifyChange('workflow_run_artifacts');
      return true;
    } catch (err) {
      log.warn(
        `Failed to replace identity stamp (${params.artifactKey}): ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
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
