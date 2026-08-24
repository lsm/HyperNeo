import type { Database as BunDatabase } from '../sqlite-compat.ts';

export type DefinitionVersionSource = 'create' | 'update' | 'backfill' | 'run_create';

export interface WorkflowDefinitionVersion {
  workflowId: string;
  versionHash: string;
  spaceId: string;
  payload: string;
  source: DefinitionVersionSource;
  createdAt: number;
}

interface DefinitionVersionRow {
  workflow_id: string;
  version_hash: string;
  space_id: string;
  payload: string;
  source: string;
  created_at: number;
}

function rowToVersion(row: DefinitionVersionRow): WorkflowDefinitionVersion {
  return {
    workflowId: row.workflow_id,
    versionHash: row.version_hash,
    spaceId: row.space_id,
    payload: row.payload,
    source: row.source as DefinitionVersionSource,
    createdAt: row.created_at,
  };
}

export class SpaceWorkflowDefinitionVersionRepository {
  constructor(private db: BunDatabase) {}

  appendVersion(params: {
    workflowId: string;
    spaceId: string;
    versionHash: string;
    payload: string;
    source: DefinitionVersionSource;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO space_workflow_definition_versions
           (workflow_id, version_hash, space_id, payload, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.workflowId,
        params.versionHash,
        params.spaceId,
        params.payload,
        params.source,
        params.createdAt
      );
  }

  getVersion(workflowId: string, versionHash: string): WorkflowDefinitionVersion | null {
    const row = this.db
      .prepare(
        `SELECT * FROM space_workflow_definition_versions
         WHERE workflow_id = ? AND version_hash = ?`
      )
      .get(workflowId, versionHash) as DefinitionVersionRow | undefined;
    return row ? rowToVersion(row) : null;
  }
}
