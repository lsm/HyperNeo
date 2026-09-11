import type {
  CreateSpaceAgentTemplateParams,
  SettingSource,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  ThinkingLevel,
  UpdateSpaceAgentTemplateParams,
  AgentModelPoolEntry,
} from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';

export type SpaceAgentTemplateRecord = SpaceAgentTemplate & { version: number };

const OWNERSHIP_MIGRATION_SENTINEL = '';

export class SpaceAgentTemplateRepository {
  constructor(private db: BunDatabase) {}

  create(params: CreateSpaceAgentTemplateParams): SpaceAgentTemplate {
    return this.createOwned(OWNERSHIP_MIGRATION_SENTINEL, params);
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

  listWithVersions(): SpaceAgentTemplateRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_agent_templates ORDER BY created_at ASC, key ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(rowToTemplateRecord);
  }

  update(key: string, params: UpdateSpaceAgentTemplateParams): SpaceAgentTemplate | null {
    return this.casUpdate(key, params, undefined);
  }

  casUpdate(
    key: string,
    params: UpdateSpaceAgentTemplateParams,
    expectedVersion?: number
  ): SpaceAgentTemplate | null {
    const { fields, values } = updateAssignments(params);

    if (fields.length === 0) {
      if (expectedVersion === undefined) return this.getByKey(key);
      const current = this.getByKeyWithVersion(key);
      return current !== null && current.version === expectedVersion ? this.getByKey(key) : null;
    }

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

  delete(key: string, expectedVersion?: number): boolean {
    const result =
      expectedVersion === undefined
        ? this.db.prepare(`DELETE FROM space_agent_templates WHERE key = ?`).run(key)
        : this.db
            .prepare(`DELETE FROM space_agent_templates WHERE key = ? AND version = ?`)
            .run(key, expectedVersion);
    return result.changes > 0;
  }

  createOwned(spaceId: string, params: CreateSpaceAgentTemplateParams): SpaceAgentTemplate {
    const now = Date.now();
    const version = this.nextVersionFor(params.key);
    this.db
      .prepare(
        `INSERT INTO space_agent_templates (
						space_id, key, handle, display_name, description, instructions,
						suggested_autonomy_level, model, provider, model_pool, thinking_level,
						setting_sources, tools, labels, created_at, updated_at, version
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        spaceId,
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
        encodeJsonArray(params.labels),
        now,
        now,
        version
      );
    return this.getOwned(spaceId, params.key) as SpaceAgentTemplate;
  }

  getOwned(spaceId: string, key: string): SpaceAgentTemplate | null {
    const row = this.ownedRow(spaceId, key);
    return row ? rowToTemplate(row) : null;
  }

  getOwnedWithVersion(spaceId: string, key: string): SpaceAgentTemplateRecord | null {
    const row = this.ownedRow(spaceId, key);
    return row ? rowToTemplateRecord(row) : null;
  }

  listOwned(spaceId: string): SpaceAgentTemplate[] {
    return this.ownedRows(spaceId).map(rowToTemplate);
  }

  listOwnedWithVersions(spaceId: string): SpaceAgentTemplateRecord[] {
    return this.ownedRows(spaceId).map(rowToTemplateRecord);
  }

  casUpdateOwned(
    spaceId: string,
    key: string,
    params: UpdateSpaceAgentTemplateParams,
    expectedVersion?: number
  ): SpaceAgentTemplate | null {
    const { fields, values } = updateAssignments(params);
    if (fields.length === 0) {
      if (expectedVersion === undefined) return this.getOwned(spaceId, key);
      const current = this.getOwnedWithVersion(spaceId, key);
      return current !== null && current.version === expectedVersion
        ? this.getOwned(spaceId, key)
        : null;
    }
    const owner = this.effectiveOwner(spaceId, key);
    if (owner === null) return null;
    fields.push('updated_at = ?');
    fields.push('version = ?');
    values.push(Date.now());
    values.push(this.nextVersionFor(key));
    values.push(owner);
    values.push(key);
    let where = `WHERE space_id = ? AND key = ?`;
    if (expectedVersion !== undefined) {
      where += ' AND version = ?';
      values.push(expectedVersion);
    }
    const result = this.db
      .prepare(`UPDATE space_agent_templates SET ${fields.join(', ')} ${where}`)
      .run(...values);
    if (result.changes === 0) return null;
    return this.getOwned(spaceId, key);
  }

  deleteOwned(spaceId: string, key: string, expectedVersion?: number): boolean {
    const owner = this.effectiveOwner(spaceId, key);
    if (owner === null) return false;
    const params: SQLiteValue[] = [owner, key];
    let sql = `DELETE FROM space_agent_templates WHERE space_id = ? AND key = ?`;
    if (expectedVersion !== undefined) {
      sql += ' AND version = ?';
      params.push(expectedVersion);
    }
    return this.db.prepare(sql).run(...params).changes > 0;
  }

  private effectiveOwner(spaceId: string, key: string): string | null {
    const row = this.db
      .prepare(
        `SELECT space_id FROM space_agent_templates
          WHERE space_id IN (?, ?) AND key = ?
          ORDER BY space_id DESC LIMIT 1`
      )
      .get(spaceId, OWNERSHIP_MIGRATION_SENTINEL, key) as { space_id: string } | undefined;
    return row ? row.space_id : null;
  }

  private ownedRow(spaceId: string, key: string): Record<string, unknown> | undefined {
    return this.db
      .prepare(
        `SELECT * FROM space_agent_templates WHERE space_id IN (?, ?) AND key = ? ORDER BY space_id DESC LIMIT 1`
      )
      .get(spaceId, OWNERSHIP_MIGRATION_SENTINEL, key) as Record<string, unknown> | undefined;
  }

  private ownedRows(spaceId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_agent_templates
          WHERE space_id IN (?, ?)
          ORDER BY created_at ASC, key ASC`
      )
      .all(spaceId, OWNERSHIP_MIGRATION_SENTINEL) as Record<string, unknown>[];
    const byKey = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const key = row.key as string;
      const existing = byKey.get(key);
      if (!existing || row.space_id !== OWNERSHIP_MIGRATION_SENTINEL) byKey.set(key, row);
    }
    return [...byKey.values()].sort(
      (a, b) =>
        (a.created_at as number) - (b.created_at as number) ||
        (a.key as string).localeCompare(b.key as string)
    );
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
    modelPool: decodeJsonArray<AgentModelPoolEntry>(row.model_pool),
    thinkingLevel: (row.thinking_level as ThinkingLevel | null) ?? null,
    settingSources: decodeJsonArray<SettingSource>(row.setting_sources),
    tools: decodeJsonArray<string>(row.tools),
    labels: decodeJsonArray<string>(row.labels) ?? [],
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    version: (row.version as number | undefined) ?? 1,
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

function updateAssignments(params: UpdateSpaceAgentTemplateParams): {
  fields: string[];
  values: SQLiteValue[];
} {
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
  if (params.labels !== undefined) {
    fields.push('labels = ?');
    values.push(encodeJsonArray(params.labels));
  }

  return { fields, values };
}
