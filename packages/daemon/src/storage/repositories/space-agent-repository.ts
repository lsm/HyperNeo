/**
 * Space Agent Repository
 *
 * CRUD operations for space_agents table.
 *
 * Column mapping:
 *   SpaceWorkerAgent.customPrompt   ↔  custom_prompt column (nullable text)
 *   SpaceWorkerAgent.tools          ↔  tools column (JSON string array; null/undefined → undefined,
 *                                                    empty array [] preserved as "inherit all")
 *   SpaceWorkerAgent.thinkingLevel  ↔  thinking_level column (nullable text)
 *   SpaceWorkerAgent.templateName   ↔  template_name column (nullable text; null for user-created agents)
 *   SpaceWorkerAgent.templateHash   ↔  template_hash column (nullable text; null for user-created agents)
 */

import type { Database as BunDatabase } from '../sqlite-compat';
import { RESERVED_SPACE_AGENT_HANDLES, slugify, slugifyWithinLimit } from '../../lib/space/slug';
import { generateUUID } from '@hyperneo/shared';
import type {
  SpaceWorkerAgent,
  CreateSpaceWorkerAgentParams,
  UpdateSpaceWorkerAgentParams,
} from '@hyperneo/shared';
import type { SQLiteValue } from '../types';

/**
 * Cap on how many referencing run IDs the deletion guard surfaces in its error
 * details. The `referenced` boolean is authoritative regardless; this only
 * bounds the list shown to the user when an agent backs many in-flight runs.
 */
const MAX_REPORTED_REFERENCING_RUNS = 10;

export class SpaceAgentRepository {
  constructor(private db: BunDatabase) {}

  /**
   * Create a new space agent
   */
  create(params: CreateSpaceWorkerAgentParams): SpaceWorkerAgent {
    const id = generateUUID();
    const now = Date.now();
    const handle = params.handle ?? this.generateUniqueHandle(params.spaceId, params.name);

    this.db
      .prepare(
        `INSERT INTO space_agents
					(id, space_id, name, handle, status, description, model, thinking_level, provider, tools, custom_prompt,
					 setting_sources, template_name, template_hash, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.name,
        handle,
        params.status ?? 'active',
        params.description ?? '',
        params.model ?? null,
        params.thinkingLevel ?? null,
        params.provider ?? null,
        params.tools != null ? JSON.stringify(params.tools) : '[]',
        params.customPrompt ?? null,
        params.settingSources != null ? JSON.stringify(params.settingSources) : null,
        params.templateName ?? null,
        params.templateHash ?? null,
        now,
        now
      );

    return this.getById(id)!;
  }

  /**
   * Get a single agent by ID
   */
  getById(id: string): SpaceWorkerAgent | null {
    const row = this.db.prepare(`SELECT * FROM space_agents WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;

    return row ? this.rowToAgent(row) : null;
  }

  /**
   * Get all agents for a space
   */
  getBySpaceId(spaceId: string): SpaceWorkerAgent[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_agents WHERE space_id = ? ORDER BY created_at ASC`)
      .all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgent(r));
  }

  /**
   * Batch lookup agents by IDs. Returns only found agents (no error on missing).
   */
  getAgentsByIds(ids: string[]): SpaceWorkerAgent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM space_agents WHERE id IN (${placeholders})`)
      .all(...(ids as SQLiteValue[])) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgent(r));
  }

  /**
   * Check if a name is already taken within a space.
   * Case-insensitive. Pass excludeId to ignore the agent being updated.
   */
  isHandleTaken(spaceId: string, handle: string, excludeId?: string): boolean {
    if (excludeId) {
      const row = this.db
        .prepare(`SELECT 1 FROM space_agents WHERE space_id = ? AND handle = ? AND id != ? LIMIT 1`)
        .get(spaceId, handle, excludeId);
      return row !== null && row !== undefined;
    }
    const row = this.db
      .prepare(`SELECT 1 FROM space_agents WHERE space_id = ? AND handle = ? LIMIT 1`)
      .get(spaceId, handle);
    return row !== null && row !== undefined;
  }

  getHandlesForSpace(spaceId: string): string[] {
    const rows = this.db
      .prepare(`SELECT handle FROM space_agents WHERE space_id = ? AND handle IS NOT NULL`)
      .all(spaceId) as Array<{ handle: string }>;
    return rows.map((row) => row.handle);
  }

  /**
   * Check if a name is already taken within a space.
   * Case-insensitive. Pass excludeId to ignore the agent being updated.
   */
  isNameTaken(spaceId: string, name: string, excludeId?: string): boolean {
    if (excludeId) {
      const row = this.db
        .prepare(
          `SELECT 1 FROM space_agents WHERE space_id = ? AND LOWER(name) = LOWER(?) AND id != ? LIMIT 1`
        )
        .get(spaceId, name, excludeId);
      return row !== null && row !== undefined;
    }
    const row = this.db
      .prepare(`SELECT 1 FROM space_agents WHERE space_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`)
      .get(spaceId, name);
    return row !== null && row !== undefined;
  }

  /**
   * Update an agent with partial updates. Returns the updated agent or null if not found.
   */
  update(id: string, params: UpdateSpaceWorkerAgentParams): SpaceWorkerAgent | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.name !== undefined) {
      fields.push('name = ?');
      values.push(params.name);
    }
    if (params.handle !== undefined) {
      fields.push('handle = ?');
      values.push(params.handle);
    }
    if (params.status !== undefined) {
      fields.push('status = ?');
      values.push(params.status);
    }
    if (params.description !== undefined) {
      fields.push('description = ?');
      values.push(params.description ?? '');
    }
    if (params.model !== undefined) {
      fields.push('model = ?');
      values.push(params.model ?? null);
    }
    if (params.thinkingLevel !== undefined) {
      fields.push('thinking_level = ?');
      values.push(params.thinkingLevel ?? null);
    }
    if (params.provider !== undefined) {
      fields.push('provider = ?');
      values.push(params.provider ?? null);
    }
    if (params.customPrompt !== undefined) {
      fields.push('custom_prompt = ?');
      values.push(params.customPrompt ?? null);
    }
    if (params.tools !== undefined) {
      fields.push('tools = ?');
      values.push(params.tools != null ? JSON.stringify(params.tools) : '[]');
    }
    if (params.settingSources !== undefined) {
      fields.push('setting_sources = ?');
      values.push(params.settingSources != null ? JSON.stringify(params.settingSources) : null);
    }
    if (params.templateName !== undefined) {
      fields.push('template_name = ?');
      values.push(params.templateName ?? null);
    }
    if (params.templateHash !== undefined) {
      fields.push('template_hash = ?');
      values.push(params.templateHash ?? null);
    }

    if (fields.length === 0) return this.getById(id);

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.db.prepare(`UPDATE space_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    // Agent labels are derived at query time by joining `space_agents.name`
    // (see live-query handlers' SPACE_TASK_MESSAGES_BASE_CTE), so a rename
    // surfaces immediately with no extra denormalised store to refresh.

    return this.getById(id);
  }

  /**
   * Delete an agent by ID
   */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(id);
  }

  /**
   * Check whether an agent is referenced by any workflow steps.
   * Returns the names of workflows that reference this agent.
   * Empty array means safe to delete.
   */
  isAgentReferenced(agentId: string): { referenced: boolean; workflowNames: string[] } {
    // config column stores JSON with agents array; use LIKE for a simple existence check
    const rows = this.db
      .prepare(
        `SELECT DISTINCT sw.name
				FROM space_workflow_nodes sws
				JOIN space_workflows sw ON sw.id = sws.workflow_id
				WHERE sws.config LIKE ?`
      )
      .all(`%"agentId":"${agentId}"%`) as Array<{ name: string }>;

    const workflowNames = rows.map((r) => r.name);
    return { referenced: workflowNames.length > 0, workflowNames };
  }

  /**
   * Check whether a non-archived (still-executable) run is pinned to a
   * definition version that references this agent (RFC §4 #5).
   *
   * `isAgentReferenced` scans only the mutable head (`space_workflow_nodes`).
   * After Phase-1 version pinning, an in-flight run executes the version pinned
   * at its creation (`space_workflow_runs.definition_version`), not the current
   * head. If that pinned version still references the agent but the head no
   * longer does (the workflow was edited, or the agent slot was removed from the
   * head), deleting the agent would strand the run: `resolveAgentInit` loads the
   * agent by id at spawn (`custom-agent.ts`) and throws "Agent not found" when it
   * is gone. Agent deletion must therefore account for executable pinned
   * versions, not just the head.
   *
   * "Non-archived" mirrors the Phase-1 backfill and the §4 #3 workflow-deletion
   * guard: a run with at least one non-archived task (`archived_at IS NULL`) is
   * still executable — reopenable `done`/`cancelled` runs qualify; only
   * `SpaceTask.archivedAt` is a non-reopenable tombstone. Runs pinned to a
   * version that does NOT reference the agent, and unpinned runs
   * (`definition_version IS NULL`, which re-read the head and are already covered
   * by `isAgentReferenced`), are excluded.
   *
   * Returns the IDs of the referencing runs (bounded) for error reporting; the
   * `referenced` flag is authoritative.
   */
  isReferencedByActivePinnedRun(agentId: string): { referenced: boolean; runIds: string[] } {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT r.id AS run_id
				FROM space_workflow_definition_versions v
				JOIN space_workflow_runs r
					ON r.workflow_id = v.workflow_id AND r.definition_version = v.version_hash
				WHERE v.payload LIKE ?
					AND EXISTS (
						SELECT 1 FROM space_tasks t
						WHERE t.workflow_run_id = r.id AND t.archived_at IS NULL
					)
				LIMIT ?`
      )
      .all(`%"agentId":"${agentId}"%`, MAX_REPORTED_REFERENCING_RUNS) as Array<{
      run_id: string;
    }>;

    const runIds = rows.map((r) => r.run_id);
    return { referenced: runIds.length > 0, runIds };
  }

  private generateUniqueHandle(spaceId: string, name: string): string {
    return slugifyWithinLimit(name, [
      ...this.getHandlesForSpace(spaceId),
      ...RESERVED_SPACE_AGENT_HANDLES,
    ]);
  }

  private rowToAgent(row: Record<string, unknown>): SpaceWorkerAgent {
    // Parse tools: null/undefined → undefined; a JSON array (including '[]')
    // → string[]. Legacy rows may store the empty string '' (the m151
    // migration treats tools = '' as an empty profile); normalize those to []
    // so JSON.parse never throws on them.
    let tools: string[] | undefined;
    const rawTools = row.tools as string | null | undefined;
    if (rawTools === '') {
      tools = [];
    } else if (rawTools) {
      tools = JSON.parse(rawTools) as string[];
    }

    // Parse settingSources: null or missing → undefined
    let settingSources: SpaceWorkerAgent['settingSources'];
    if (row.setting_sources) {
      settingSources = JSON.parse(
        row.setting_sources as string
      ) as SpaceWorkerAgent['settingSources'];
    }

    return {
      id: row.id as string,
      spaceId: row.space_id as string,
      name: row.name as string,
      handle: (row.handle as string | null | undefined) ?? slugify(row.name as string),
      status: (row.status as SpaceWorkerAgent['status'] | null | undefined) ?? 'active',
      description: (row.description as string) || undefined,
      model: (row.model as string | null) ?? undefined,
      thinkingLevel:
        (row.thinking_level as SpaceWorkerAgent['thinkingLevel'] | null | undefined) ?? undefined,
      provider: (row.provider as string | null) ?? undefined,
      customPrompt: (row.custom_prompt as string | null) ?? null,
      tools,
      settingSources,
      // `template_name` / `template_hash` may be missing entirely on
      // schemas that predate M105 — guard with `??` so older test DBs
      // (and any pre-migration call paths) don't return `undefined`.
      templateName: (row.template_name as string | null | undefined) ?? null,
      templateHash: (row.template_hash as string | null | undefined) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
