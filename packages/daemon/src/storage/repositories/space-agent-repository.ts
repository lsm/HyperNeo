import type {
  CreateSpaceAgentParams,
  SpaceAgent,
  SpaceAgentAutonomyLevel,
  SpaceAgentStatus,
  UpdateSpaceAgentParams,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../lib/space/agents/worker-long-horizon-mapper.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';

const AGENTS_TABLE = 'space_long_horizon_agents';

export interface SpaceAgentIdentity {
  id: string;
  handle: string;
  displayName: string;
  status: SpaceAgentStatus;
}

export class SpaceAgentRepository {
  constructor(private db: BunDatabase) {}

  create(params: CreateSpaceAgentParams): SpaceAgent {
    const id = params.id ?? generateUUID();
    const now = Date.now();

    const insert = this.db.transaction(() => {
      this.requireSessionUnbound(params.sessionId ?? null, id);
      this.insertRow(id, params, now);
    });
    insert();

    return this.getById(id) as SpaceAgent;
  }

  private insertRow(id: string, params: CreateSpaceAgentParams, now: number): void {
    this.db
      .prepare(
        `INSERT INTO ${AGENTS_TABLE} (
           id, space_id, handle, display_name, description, instructions, status, session_id,
           autonomy_level, model, provider, model_pool, thinking_level, setting_sources,
           tool_permissions_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.spaceId,
        params.handle,
        params.displayName ?? params.handle,
        params.description ?? null,
        params.instructions ?? '',
        params.status ?? 'active',
        params.sessionId ?? null,
        params.autonomyLevel ?? null,
        params.model ?? null,
        params.provider ?? null,
        serializeModelPool(params.modelPool),
        params.thinkingLevel ?? null,
        serializeSettingSources(params.settingSources),
        JSON.stringify(withTools({}, params.tools ?? null)),
        now,
        now
      );
  }

  getById(id: string): SpaceAgent | null {
    const row = this.db.prepare(`SELECT * FROM ${AGENTS_TABLE} WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSpaceAgent(row) : null;
  }

  getByHandle(spaceId: string, handle: string): SpaceAgent | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${AGENTS_TABLE} WHERE space_id = ? AND handle = ? AND status != 'archived'`
      )
      .get(spaceId, handle) as Record<string, unknown> | undefined;
    return row ? rowToSpaceAgent(row) : null;
  }

  getBySessionId(sessionId: string): SpaceAgent | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${AGENTS_TABLE} WHERE session_id = ?
         ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? rowToSpaceAgent(row) : null;
  }

  listOwnedBySpaceId(spaceId: string): SpaceAgent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${AGENTS_TABLE}
         WHERE space_id = ? AND (template_key IS NULL OR template_key != ?)
         ORDER BY created_at ASC`
      )
      .all(spaceId, MIGRATED_WORKER_TEMPLATE_KEY) as Record<string, unknown>[];
    return rows.map(rowToSpaceAgent);
  }

  getOwnedById(id: string): SpaceAgent | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${AGENTS_TABLE}
         WHERE id = ? AND (template_key IS NULL OR template_key != ?)`
      )
      .get(id, MIGRATED_WORKER_TEMPLATE_KEY) as Record<string, unknown> | undefined;
    return row ? rowToSpaceAgent(row) : null;
  }

  listIdentitiesBySpaceId(spaceId: string): SpaceAgentIdentity[] {
    const rows = this.db
      .prepare(
        `SELECT id, handle, display_name, status FROM ${AGENTS_TABLE}
         WHERE space_id = ? ORDER BY created_at ASC`
      )
      .all(spaceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      handle: row.handle as string,
      displayName: row.display_name as string,
      status: row.status as SpaceAgentStatus,
    }));
  }

  update(id: string, params: UpdateSpaceAgentParams): SpaceAgent | null {
    if (!this.getById(id)) return null;
    this.requireNotMigratedWorkerMirror(id);
    if (params.sessionId !== undefined) this.requireSessionUnbound(params.sessionId ?? null, id);

    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    const setField = (column: string, value: SQLiteValue) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if (params.handle !== undefined) setField('handle', params.handle);
    if (params.displayName !== undefined) setField('display_name', params.displayName);
    if (params.description !== undefined) setField('description', params.description ?? null);
    if (params.instructions !== undefined) setField('instructions', params.instructions);
    if (params.status !== undefined) setField('status', params.status);
    if (params.sessionId !== undefined) setField('session_id', params.sessionId ?? null);
    if (params.autonomyLevel !== undefined)
      setField('autonomy_level', params.autonomyLevel ?? null);
    if (params.model !== undefined) setField('model', params.model ?? null);
    if (params.provider !== undefined) setField('provider', params.provider ?? null);
    if (params.modelPool !== undefined)
      setField('model_pool', serializeModelPool(params.modelPool));
    if (params.thinkingLevel !== undefined)
      setField('thinking_level', params.thinkingLevel ?? null);
    if (params.settingSources !== undefined) {
      setField('setting_sources', serializeSettingSources(params.settingSources));
    }
    if (params.tools !== undefined) {
      const existing = this.readToolPermissions(id);
      setField('tool_permissions_json', JSON.stringify(withTools(existing, params.tools ?? null)));
    }

    if (fields.length === 0) return this.getById(id);

    fields.push('updated_at = ?');
    values.push(Date.now(), id);
    this.db.prepare(`UPDATE ${AGENTS_TABLE} SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getById(id);
  }

  delete(id: string): void {
    this.requireNotMigratedWorkerMirror(id);
    this.db.prepare(`DELETE FROM ${AGENTS_TABLE} WHERE id = ?`).run(id);
  }

  private readToolPermissions(id: string): Record<string, unknown> {
    const row = this.db
      .prepare(`SELECT tool_permissions_json FROM ${AGENTS_TABLE} WHERE id = ?`)
      .get(id) as { tool_permissions_json?: unknown } | undefined;
    return parseObject(row?.tool_permissions_json);
  }

  private requireNotMigratedWorkerMirror(id: string): void {
    const row = this.db.prepare(`SELECT template_key FROM ${AGENTS_TABLE} WHERE id = ?`).get(id) as
      | { template_key?: string | null }
      | undefined;
    if (row?.template_key === MIGRATED_WORKER_TEMPLATE_KEY) {
      throw new Error(
        `Agent ${id} is a migrated worker mirror and is not owned by SpaceAgentRepository`
      );
    }
  }

  private requireSessionUnbound(sessionId: string | null, agentId: string): void {
    if (sessionId === null) return;
    const row = this.db
      .prepare(`SELECT id FROM ${AGENTS_TABLE} WHERE session_id = ? AND id != ? LIMIT 1`)
      .get(sessionId, agentId) as { id?: string } | undefined;
    if (row?.id) {
      throw new Error(`Session ${sessionId} is already bound to agent ${row.id}`);
    }
  }
}

function withTools(
  permissions: Record<string, unknown>,
  tools: string[] | null
): Record<string, unknown> {
  const next = { ...permissions };
  if (tools === null) {
    delete next.tools;
    return next;
  }
  next.tools = [...tools];
  return next;
}

function serializeModelPool(pool: CreateSpaceAgentParams['modelPool']): string | null {
  return pool != null && pool.length > 0 ? JSON.stringify(pool) : null;
}

function serializeSettingSources(sources: CreateSpaceAgentParams['settingSources']): string | null {
  return sources == null ? null : JSON.stringify(sources);
}

function rowToSpaceAgent(row: Record<string, unknown>): SpaceAgent {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    handle: row.handle as string,
    displayName: row.display_name as string,
    description: (row.description as string | null) ?? null,
    instructions: (row.instructions as string | null) ?? '',
    status: row.status as SpaceAgentStatus,
    sessionId: (row.session_id as string | null) ?? null,
    autonomyLevel: (row.autonomy_level as SpaceAgentAutonomyLevel | null) ?? null,
    model: (row.model as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    modelPool: row.model_pool
      ? (JSON.parse(row.model_pool as string) as SpaceAgent['modelPool'])
      : null,
    thinkingLevel: (row.thinking_level as SpaceAgent['thinkingLevel']) ?? null,
    settingSources: row.setting_sources
      ? (JSON.parse(row.setting_sources as string) as SpaceAgent['settingSources'])
      : null,
    tools: toolsFromPermissions(parseObject(row.tool_permissions_json)),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toolsFromPermissions(permissions: Record<string, unknown>): string[] | null {
  const tools = permissions.tools;
  if (!Array.isArray(tools)) return null;
  return tools.filter((tool): tool is string => typeof tool === 'string');
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
