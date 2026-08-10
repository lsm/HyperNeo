/**
 * SpaceWorkflowDefinitionVersionRepository
 *
 * Append-only history of immutable workflow-definition snapshots (RFC §4, Phase 1).
 *
 * Each row is a full, self-contained snapshot of a definition identified by `version_hash`
 * — a SHA-256 of its canonical payload (see `computeDefinitionVersion`). Rows are immutable
 * once written: `appendVersion` uses `INSERT OR IGNORE` keyed on
 * `(workflow_id, version_hash)`, so re-appending the same version is a no-op and the history
 * never mutates a prior version.
 *
 * Read cutover (Phase 1): run reads resolve through these rows. `getVersion` is the reader
 * `SpaceWorkflowRepository.getDefinitionVersion` / `getWorkflowForRun` use to resolve a
 * pinned run to its definition version instead of the mutable `space_workflows` head row, so
 * a later edit cannot change what an in-flight run executes. List/count readers remain
 * deferred — no runtime caller needs them yet.
 *
 * Foreign keys: there is intentionally NO FK to `space_workflows(id)` — the RFC's
 * orphan/tombstone policy requires pinned versions to survive deletion of the mutable head
 * (a soft-deleted definition leaves runs pinned to their version). There IS a
 * `FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE`: when a whole Space is
 * deleted, every run in it is gone (space_workflow_runs cascades the same way), so no run
 * remains to pin a version, and the version payloads (prompts/instructions) must not outlive
 * the Space. Individual-workflow deletion preserves versions; whole-Space deletion cleans them.
 */

import type { Database as BunDatabase } from '../sqlite-compat';

/** How a version row came to be appended. */
export type DefinitionVersionSource = 'create' | 'update' | 'backfill' | 'run_create';

export interface WorkflowDefinitionVersion {
  workflowId: string;
  versionHash: string;
  spaceId: string;
  /** Canonical JSON of the definition at this version. Hash is derived from this. */
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

  /**
   * Append an immutable version snapshot. Idempotent on `(workflow_id, version_hash)`:
   * re-appending the same version (e.g. a no-op re-stamp) is a silent no-op and never throws.
   */
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

  /** Fetch a specific version of a workflow, or null if absent. */
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
