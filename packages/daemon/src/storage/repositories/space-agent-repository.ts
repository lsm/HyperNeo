/**
 * Space Agent Repository
 *
 * CRUD operations for space_agents table.
 *
 * Column mapping:
 *   SpaceAgent.customPrompt   ↔  custom_prompt column (nullable text)
 *   SpaceAgent.tools          ↔  tools column (JSON string array; '[]' or null → undefined)
 *   SpaceAgent.thinkingLevel  ↔  thinking_level column (nullable text)
 *   SpaceAgent.templateName   ↔  template_name column (nullable text; null for user-created agents)
 *   SpaceAgent.templateHash   ↔  template_hash column (nullable text; null for user-created agents)
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type { SpaceAgent, CreateSpaceAgentParams, UpdateSpaceAgentParams } from '@neokai/shared';
import type { SQLiteValue } from '../types';

export class SpaceAgentRepository {
	constructor(private db: BunDatabase) {}

	/**
	 * Create a new space agent
	 */
	create(params: CreateSpaceAgentParams): SpaceAgent {
		const id = generateUUID();
		const now = Date.now();

		this.db
			.prepare(
				`INSERT INTO space_agents
					(id, space_id, name, status, description, model, thinking_level, provider, tools, custom_prompt,
					 setting_sources, template_name, template_hash, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				id,
				params.spaceId,
				params.name,
				params.status ?? 'active',
				params.description ?? '',
				params.model ?? null,
				params.thinkingLevel ?? null,
				params.provider ?? null,
				params.tools && params.tools.length > 0 ? JSON.stringify(params.tools) : '[]',
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
	getById(id: string): SpaceAgent | null {
		const row = this.db.prepare(`SELECT * FROM space_agents WHERE id = ?`).get(id) as
			| Record<string, unknown>
			| undefined;

		return row ? this.rowToAgent(row) : null;
	}

	/**
	 * Get all agents for a space
	 */
	getBySpaceId(spaceId: string): SpaceAgent[] {
		const rows = this.db
			.prepare(`SELECT * FROM space_agents WHERE space_id = ? ORDER BY created_at ASC`)
			.all(spaceId) as Record<string, unknown>[];
		return rows.map((r) => this.rowToAgent(r));
	}

	/**
	 * Batch lookup agents by IDs. Returns only found agents (no error on missing).
	 */
	getAgentsByIds(ids: string[]): SpaceAgent[] {
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
	update(id: string, params: UpdateSpaceAgentParams): SpaceAgent | null {
		const fields: string[] = [];
		const values: SQLiteValue[] = [];

		if (params.name !== undefined) {
			fields.push('name = ?');
			values.push(params.name);
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
			values.push(params.tools && params.tools.length > 0 ? JSON.stringify(params.tools) : '[]');
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

	private rowToAgent(row: Record<string, unknown>): SpaceAgent {
		// Parse tools: '[]' or null → undefined; non-empty JSON array → string[]
		let tools: string[] | undefined;
		if (row.tools) {
			const parsed = JSON.parse(row.tools as string) as string[];
			tools = parsed.length > 0 ? parsed : undefined;
		}

		// Parse settingSources: null or missing → undefined
		let settingSources: SpaceAgent['settingSources'];
		if (row.setting_sources) {
			settingSources = JSON.parse(row.setting_sources as string) as SpaceAgent['settingSources'];
		}

		return {
			id: row.id as string,
			spaceId: row.space_id as string,
			name: row.name as string,
			status: (row.status as SpaceAgent['status'] | null | undefined) ?? 'active',
			description: (row.description as string) || undefined,
			model: (row.model as string | null) ?? undefined,
			thinkingLevel:
				(row.thinking_level as SpaceAgent['thinkingLevel'] | null | undefined) ?? undefined,
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
