import type { Database as BunDatabase } from '../sqlite-compat';
import { RESERVED_SPACE_AGENT_HANDLES, slugify, slugifyWithinLimit } from '../../lib/space/slug';
import { generateUUID } from '@hyperneo/shared';
import type {
  SpaceWorkerAgent,
  CreateSpaceWorkerAgentParams,
  UpdateSpaceWorkerAgentParams,
} from '@hyperneo/shared';
import type { SQLiteValue } from '../types';

export class SpaceAgentRepository {
  constructor(private db: BunDatabase) {}

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

  getById(id: string): SpaceWorkerAgent | null {
    const row = this.db.prepare(`SELECT * FROM space_agents WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;

    return row ? this.rowToAgent(row) : null;
  }

  getBySpaceId(spaceId: string): SpaceWorkerAgent[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_agents WHERE space_id = ? ORDER BY created_at ASC`)
      .all(spaceId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgent(r));
  }

  getAgentsByIds(ids: string[]): SpaceWorkerAgent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM space_agents WHERE id IN (${placeholders})`)
      .all(...(ids as SQLiteValue[])) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgent(r));
  }

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

    return this.getById(id);
  }

  delete(id: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare(`SELECT space_id FROM space_agents WHERE id = ?`).get(id) as {
        space_id: string;
      } | null;
      const hasInbox = !!this.db
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_agent_inbox_messages'`
        )
        .get();
      const hasSiblingLhAgent =
        row != null &&
        !!this.db
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'space_long_horizon_agents'`
          )
          .get()
          ? !!this.db
              .prepare(`SELECT 1 FROM space_long_horizon_agents WHERE id = ? AND space_id = ?`)
              .get(id, row.space_id)
          : false;
      if (hasInbox && !hasSiblingLhAgent) {
        this.db.prepare(`DELETE FROM space_agent_inbox_messages WHERE target_agent_id = ?`).run(id);
      }
      this.db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(id);
    })();
  }

  isAgentReferenced(agentId: string): { referenced: boolean; workflowNames: string[] } {
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

  private generateUniqueHandle(spaceId: string, name: string): string {
    return slugifyWithinLimit(name, [
      ...this.getHandlesForSpace(spaceId),
      ...RESERVED_SPACE_AGENT_HANDLES,
    ]);
  }

  private rowToAgent(row: Record<string, unknown>): SpaceWorkerAgent {
    let tools: string[] | undefined;
    const rawTools = row.tools as string | null | undefined;
    if (rawTools === '') {
      tools = [];
    } else if (rawTools) {
      tools = JSON.parse(rawTools) as string[];
    }

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
      templateName: (row.template_name as string | null | undefined) ?? null,
      templateHash: (row.template_hash as string | null | undefined) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
