import type {
  CreateSpaceAgentTemplateParams,
  SettingSource,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  ThinkingLevel,
  UpdateSpaceAgentTemplateParams,
  WorkerAgentModelPoolEntry,
} from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';

export type SpaceAgentTemplateRecord = SpaceAgentTemplate & { version: number };

export class SpaceAgentTemplateRepository {
  constructor(private db: BunDatabase) {}

  create(params: CreateSpaceAgentTemplateParams): SpaceAgentTemplate {
    const now = Date.now();
    const version = this.nextVersionFor(params.key);
    this.db
      .prepare(
        `INSERT INTO space_agent_templates (
						key, handle, display_name, description, instructions, suggested_autonomy_level,
						model, provider, model_pool, thinking_level, setting_sources, tools,
						created_at, updated_at, version
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.key,
        params.handle,
        params.displayName ?? params.handle,
        params.description ?? '',
        params.instructions ?? '',
        params.suggestedAutonomyLevel ?? 2,
        params.model ?? null,
        params.provider ?? null,
        encodeJsonArray(params.modelPool),
        params.thinkingLevel ?? null,
        params.settingSources === undefined ? null : JSON.stringify(params.settingSources),
        encodeJsonArray(params.tools),
        now,
        now,
        version
      );
    return this.getByKey(params.key) as SpaceAgentTemplate;
  }

  getByKey(key: string): SpaceAgentTemplate | null {
    const row = this.db.prepare(`SELECT * FROM space_agent_templates WHERE key = ?`).get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTemplate(row) : null;
  }

  getByKeyWithVersion(key: string): SpaceAgentTemplateRecord | null {
    const row = this.db.prepare(`SELECT * FROM space_agent_templates WHERE key = ?`).get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTemplateRecord(row) : null;
  }

  list(): SpaceAgentTemplate[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_agent_templates ORDER BY created_at ASC, key ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToTemplate);
  }

  update(key: string, params: UpdateSpaceAgentTemplateParams): SpaceAgentTemplate | null {
    return this.casUpdate(key, params, undefined);
  }

  casUpdate(
    key: string,
    params: UpdateSpaceAgentTemplateParams,
    expectedVersion?: number
  ): SpaceAgentTemplate | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.handle !== undefined) {
      fields.push('handle = ?');
      values.push(params.handle);
    }
    if (params.displayName !== undefined) {
      fields.push('display_name = ?');
      values.push(params.displayName);
    }
    if (params.description !== undefined) {
      fields.push('description = ?');
      values.push(params.description);
    }
    if (params.instructions !== undefined) {
      fields.push('instructions = ?');
      values.push(params.instructions);
    }
    if (params.suggestedAutonomyLevel !== undefined) {
      fields.push('suggested_autonomy_level = ?');
      values.push(params.suggestedAutonomyLevel);
    }
    if (params.model !== undefined) {
      fields.push('model = ?');
      values.push(params.model ?? null);
    }
    if (params.provider !== undefined) {
      fields.push('provider = ?');
      values.push(params.provider ?? null);
    }
    if (params.modelPool !== undefined) {
      fields.push('model_pool = ?');
      values.push(encodeJsonArray(params.modelPool));
    }
    if (params.thinkingLevel !== undefined) {
      fields.push('thinking_level = ?');
      values.push(params.thinkingLevel ?? null);
    }
    if (params.settingSources !== undefined) {
      fields.push('setting_sources = ?');
      values.push(params.settingSources === null ? null : JSON.stringify(params.settingSources));
    }
    if (params.tools !== undefined) {
      fields.push('tools = ?');
      values.push(encodeJsonArray(params.tools));
    }

    if (fields.length === 0) return this.getByKey(key);

    const nextVersion = this.nextVersionFor(key);
    fields.push('updated_at = ?');
    fields.push('version = ?');
    values.push(Date.now());
    values.push(nextVersion);

    const where = expectedVersion === undefined ? 'WHERE key = ?' : 'WHERE key = ? AND version = ?';
    values.push(key);
    if (expectedVersion !== undefined) values.push(expectedVersion);

    const result = this.db
      .prepare(`UPDATE space_agent_templates SET ${fields.join(', ')} ${where}`)
      .run(...values);
    if (result.changes === 0) return null;
    return this.getByKey(key);
  }

  delete(key: string): boolean {
    const result = this.db.prepare(`DELETE FROM space_agent_templates WHERE key = ?`).run(key);
    return result.changes > 0;
  }

  private nextVersionFor(key: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO space_agent_template_version_seq (key, next_version) VALUES (?, 1)
					 ON CONFLICT(key) DO UPDATE SET next_version = next_version + 1
					 RETURNING next_version`
      )
      .get(key) as { next_version: number } | undefined;
    return row?.next_version ?? 1;
  }
}

function rowToTemplate(row: Record<string, unknown>): SpaceAgentTemplate {
  return {
    key: row.key as string,
    handle: row.handle as string,
    displayName: row.display_name as string,
    description: (row.description as string | null) ?? '',
    instructions: (row.instructions as string | null) ?? '',
    suggestedAutonomyLevel: row.suggested_autonomy_level as SpaceAgentAutonomyLevel,
    model: (row.model as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    modelPool: decodeJsonArray<WorkerAgentModelPoolEntry>(row.model_pool),
    thinkingLevel: (row.thinking_level as ThinkingLevel | null) ?? null,
    settingSources: decodeJsonArray<SettingSource>(row.setting_sources),
    tools: decodeJsonArray<string>(row.tools),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToTemplateRecord(row: Record<string, unknown>): SpaceAgentTemplateRecord {
  return {
    ...rowToTemplate(row),
    version: (row.version as number | undefined) ?? 1,
  };
}

function encodeJsonArray<T>(value: T[] | null | undefined): string | null {
  return value != null && value.length > 0 ? JSON.stringify(value) : null;
}

function decodeJsonArray<T>(value: unknown): T[] | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return JSON.parse(value) as T[];
}
