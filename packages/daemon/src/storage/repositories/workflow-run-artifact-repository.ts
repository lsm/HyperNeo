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
  constructor(
    private db: BunDatabase,
    private reactiveDb?: ReactiveDatabase
  ) {}

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

  listByRun(
    runId: string,
    filters?: { nodeId?: string; artifactType?: string }
  ): WorkflowRunArtifactRecord[] {
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
    sql += ' ORDER BY created_at ASC';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows
      .map((r) => this.rowToRecord(r))
      .filter((r): r is WorkflowRunArtifactRecord => r !== null);
  }

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
      return null;
    }
  }
}
