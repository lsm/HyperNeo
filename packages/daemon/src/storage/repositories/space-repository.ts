import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';
import type {
  Space,
  SpaceAutonomyLevel,
  SpaceConfig,
  CreateSpaceParams,
  UpdateSpaceParams,
} from '@hyperneo/shared';
import type { SQLiteValue } from '../types.ts';

export class SpaceRepository {
  constructor(private db: BunDatabase) {}

  private tableExists(tableName: string): boolean {
    try {
      const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(tableName);
      return !!row;
    } catch {
      return false;
    }
  }

  createSpace(params: CreateSpaceParams & { slug: string }): Space {
    const id = generateUUID();
    const now = Date.now();

    const stmt = this.db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, description, background_context, instructions, default_model, allowed_models, session_ids, status, autonomy_level, max_concurrent_tasks, config, setting_sources, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    stmt.run(
      id,
      params.slug,
      params.workspacePath,
      params.name,
      params.description ?? '',
      params.backgroundContext ?? '',
      params.instructions ?? '',
      params.defaultModel ?? null,
      JSON.stringify(params.allowedModels ?? []),
      '[]',
      'active',
      params.autonomyLevel ?? 1,
      params.maxConcurrentTasks ?? params.config?.maxConcurrentTasks ?? 1,
      params.config ? JSON.stringify(params.config) : null,
      params.settingSources != null ? JSON.stringify(params.settingSources) : null,
      now,
      now
    );

    return this.getSpace(id)!;
  }

  getSpace(id: string): Space | null {
    const stmt = this.db.prepare(`SELECT * FROM spaces WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToSpace(row);
  }

  getSpaceByPath(workspacePath: string): Space | null {
    const stmt = this.db.prepare(`SELECT * FROM spaces WHERE workspace_path = ?`);
    const row = stmt.get(workspacePath) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToSpace(row);
  }

  getSpaceBySlug(slug: string): Space | null {
    const stmt = this.db.prepare(`SELECT * FROM spaces WHERE slug = ?`);
    const row = stmt.get(slug) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToSpace(row);
  }

  updateSlug(id: string, slug: string): Space | null {
    const stmt = this.db.prepare(`UPDATE spaces SET slug = ?, updated_at = ? WHERE id = ?`);
    stmt.run(slug, Date.now(), id);
    return this.getSpace(id);
  }

  getAllSlugs(): string[] {
    const rows = this.db.prepare(`SELECT slug FROM spaces WHERE slug IS NOT NULL`).all() as Array<{
      slug: string;
    }>;
    return rows.map((r) => r.slug);
  }

  listSpaces(includeArchived = false): Space[] {
    let query = `SELECT * FROM spaces`;
    if (!includeArchived) {
      query += ` WHERE status = 'active'`;
    }
    query += ` ORDER BY updated_at DESC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToSpace(r));
  }

  updateSpace(id: string, params: UpdateSpaceParams): Space | null {
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (params.name !== undefined) {
      fields.push('name = ?');
      values.push(params.name);
    }
    if (params.description !== undefined) {
      fields.push('description = ?');
      values.push(params.description);
    }
    if (params.backgroundContext !== undefined) {
      fields.push('background_context = ?');
      values.push(params.backgroundContext);
    }
    if (params.instructions !== undefined) {
      fields.push('instructions = ?');
      values.push(params.instructions);
    }
    if (params.defaultModel !== undefined) {
      fields.push('default_model = ?');
      values.push(params.defaultModel ?? null);
    }
    if (params.allowedModels !== undefined) {
      fields.push('allowed_models = ?');
      values.push(JSON.stringify(params.allowedModels));
    }
    if (params.autonomyLevel !== undefined) {
      fields.push('autonomy_level = ?');
      values.push(params.autonomyLevel);
    }
    if (params.maxConcurrentTasks !== undefined) {
      fields.push('max_concurrent_tasks = ?');
      values.push(params.maxConcurrentTasks);
    }
    if (params.config !== undefined) {
      fields.push('config = ?');
      values.push(JSON.stringify(params.config));
      if (
        params.maxConcurrentTasks === undefined &&
        params.config?.maxConcurrentTasks !== undefined
      ) {
        fields.push('max_concurrent_tasks = ?');
        values.push(params.config.maxConcurrentTasks);
      }
    }

    if (params.settingSources !== undefined) {
      fields.push('setting_sources = ?');
      values.push(params.settingSources != null ? JSON.stringify(params.settingSources) : null);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(id);
      const stmt = this.db.prepare(`UPDATE spaces SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
    }

    return this.getSpace(id);
  }

  pauseSpace(id: string): Space | null {
    const stmt = this.db.prepare(`UPDATE spaces SET paused = 1, updated_at = ? WHERE id = ?`);
    stmt.run(Date.now(), id);
    return this.getSpace(id);
  }

  resumeSpace(id: string): Space | null {
    const stmt = this.db.prepare(`UPDATE spaces SET paused = 0, updated_at = ? WHERE id = ?`);
    stmt.run(Date.now(), id);
    return this.getSpace(id);
  }

  stopSpace(id: string): Space | null {
    const stmt = this.db.prepare(`UPDATE spaces SET stopped = 1, updated_at = ? WHERE id = ?`);
    stmt.run(Date.now(), id);
    return this.getSpace(id);
  }

  startSpace(id: string): Space | null {
    const stmt = this.db.prepare(
      `UPDATE spaces SET stopped = 0, paused = 0, updated_at = ? WHERE id = ?`
    );
    stmt.run(Date.now(), id);
    return this.getSpace(id);
  }

  archiveSpace(id: string): Space | null {
    const stmt = this.db.prepare(
      `UPDATE spaces SET status = 'archived', updated_at = ? WHERE id = ?`
    );
    stmt.run(Date.now(), id);
    return this.getSpace(id);
  }

  addSessionToSpace(spaceId: string, sessionId: string): Space | null {
    const tx = this.db.transaction(() => {
      const space = this.getSpace(spaceId);
      if (!space) return null;

      if (space.sessionIds.includes(sessionId)) {
        return space;
      }

      const sessionIds = [...space.sessionIds, sessionId];
      const stmt = this.db.prepare(
        `UPDATE spaces SET session_ids = ?, updated_at = ? WHERE id = ?`
      );
      stmt.run(JSON.stringify(sessionIds), Date.now(), spaceId);
      return this.getSpace(spaceId);
    });

    return tx() as Space | null;
  }

  removeSessionFromSpace(spaceId: string, sessionId: string): Space | null {
    const tx = this.db.transaction(() => {
      const space = this.getSpace(spaceId);
      if (!space) return null;

      if (!space.sessionIds.includes(sessionId)) {
        return space;
      }

      const sessionIds = space.sessionIds.filter((id) => id !== sessionId);
      const stmt = this.db.prepare(
        `UPDATE spaces SET session_ids = ?, updated_at = ? WHERE id = ?`
      );
      stmt.run(JSON.stringify(sessionIds), Date.now(), spaceId);
      return this.getSpace(spaceId);
    });

    return tx() as Space | null;
  }

  deleteSpace(id: string): boolean {
    const deleteSearchRows = this.tableExists('message_search_content')
      ? this.db.prepare(`DELETE FROM message_search_content WHERE space_id = ?`)
      : null;
    const deletePendingRows = this.tableExists('message_search_pending')
      ? this.db.prepare(
          `DELETE FROM message_search_pending
           WHERE message_id IN (
             SELECT id FROM sdk_messages WHERE task_id IN (SELECT id FROM space_tasks WHERE space_id = ?)
           )`
        )
      : null;
    const deleteSpace = this.db.prepare(`DELETE FROM spaces WHERE id = ?`);
    const tx = this.db.transaction((spaceId: string) => {
      deleteSearchRows?.run(spaceId);
      deletePendingRows?.run(spaceId);
      return deleteSpace.run(spaceId);
    });
    const result = tx(id);
    return result.changes > 0;
  }

  private rowToSpace(row: Record<string, unknown>): Space {
    const rawModels = JSON.parse((row.allowed_models as string) ?? '[]') as string[];
    const rawConfig = row.config as string | null;
    const config = rawConfig ? (JSON.parse(rawConfig) as SpaceConfig) : undefined;

    const rawSettingSources = row.setting_sources as string | null;
    const settingSources = rawSettingSources
      ? (JSON.parse(rawSettingSources) as Space['settingSources'])
      : undefined;
    return {
      id: row.id as string,
      slug: (row.slug as string) ?? '',
      workspacePath: row.workspace_path as string,
      name: row.name as string,
      description: (row.description as string) ?? '',
      backgroundContext: (row.background_context as string) ?? '',
      instructions: (row.instructions as string) ?? '',
      defaultModel: (row.default_model as string | null) ?? undefined,
      allowedModels: rawModels.length > 0 ? rawModels : undefined,
      sessionIds: JSON.parse(row.session_ids as string) as string[],
      status: row.status as 'active' | 'archived',
      paused: (row.paused as number) === 1,
      stopped: (row.stopped as number) === 1,
      autonomyLevel: ((row.autonomy_level as number) ?? 1) as SpaceAutonomyLevel,
      maxConcurrentTasks:
        (row.max_concurrent_tasks as number | null | undefined) ?? config?.maxConcurrentTasks ?? 1,
      config,
      settingSources,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
