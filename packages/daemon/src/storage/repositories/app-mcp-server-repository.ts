/**
 * AppMcpServerRepository
 *
 * CRUD operations for the application-level MCP server registry.
 * Each write method calls reactiveDb.notifyChange('app_mcp_servers') so that
 * LiveQueryEngine can invalidate frontend subscriptions on every registry change.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@hyperneo/shared';
import type {
  AppMcpServer,
  AppMcpServerSource,
  AppMcpServerSourceType,
  CreateAppMcpServerRequest,
  UpdateAppMcpServerRequest,
} from '@hyperneo/shared';
import type { ReactiveDatabase } from '../reactive-database';
import type { SQLiteValue } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SOURCE_TYPES = new Set<AppMcpServerSourceType>(['stdio', 'sse', 'http']);
const VALID_SOURCES = new Set<AppMcpServerSource>(['builtin', 'user', 'imported']);

// ---------------------------------------------------------------------------
// Internal row type (mirrors SQLite columns)
// ---------------------------------------------------------------------------

interface AppMcpServerRow {
  id: string;
  name: string;
  description: string | null;
  source_type: string;
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  headers: string | null;
  enabled: number;
  source: string | null;
  source_path: string | null;
  created_at: number | null;
  updated_at: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToServer(row: AppMcpServerRow): AppMcpServer {
  // Legacy rows written before migration 100 landed may have `source=NULL`.
  // Treat them as 'user' for forward compatibility — migration 100 backfills
  // on next startup, but we don't want a transient read to crash or return
  // an invalid discriminant to the UI.
  const source = (row.source ?? 'user') as AppMcpServerSource;

  return {
    id: row.id,
    name: row.name,
    ...(row.description !== null ? { description: row.description } : {}),
    sourceType: row.source_type as AppMcpServerSourceType,
    ...(row.command !== null ? { command: row.command } : {}),
    ...(row.args !== null ? { args: JSON.parse(row.args) as string[] } : {}),
    ...(row.env !== null ? { env: JSON.parse(row.env) as Record<string, string> } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.headers !== null ? { headers: JSON.parse(row.headers) as Record<string, string> } : {}),
    enabled: row.enabled === 1,
    source,
    ...(row.source_path !== null ? { sourcePath: row.source_path } : {}),
    ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
  };
}

function validateSourceType(sourceType: string): void {
  if (!VALID_SOURCE_TYPES.has(sourceType as AppMcpServerSourceType)) {
    throw new Error(
      `Invalid sourceType "${sourceType}". Must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}`
    );
  }
}

function validateSource(source: string): void {
  if (!VALID_SOURCES.has(source as AppMcpServerSource)) {
    throw new Error(`Invalid source "${source}". Must be one of: ${[...VALID_SOURCES].join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class AppMcpServerRepository {
  constructor(
    private db: BunDatabase,
    private reactiveDb: ReactiveDatabase
  ) {}

  /**
   * Check whether a name is already taken in the registry.
   * Pass `excludeId` when renaming an existing entry to avoid a false positive.
   */
  isNameTaken(name: string, excludeId?: string): boolean {
    if (excludeId) {
      const row = this.db
        .prepare(`SELECT 1 FROM app_mcp_servers WHERE name = ? AND id != ?`)
        .get(name, excludeId);
      return row !== null;
    }
    const row = this.db.prepare(`SELECT 1 FROM app_mcp_servers WHERE name = ?`).get(name);
    return row !== null;
  }

  /**
   * Create a new MCP server registry entry.
   * Throws if the name is already taken, if sourceType is invalid, or if
   * `source` is supplied with an invalid value. Defaults:
   *   - `source` defaults to `'user'` (matches pre-M2 behaviour).
   *   - `sourcePath` must be an absolute path when `source === 'imported'`
   *     and must be omitted/null otherwise — callers are trusted to enforce
   *     this; the import service is the only sanctioned writer for 'imported'.
   */
  create(req: CreateAppMcpServerRequest): AppMcpServer {
    validateSourceType(req.sourceType);

    const source: AppMcpServerSource = req.source ?? 'user';
    validateSource(source);

    if (this.isNameTaken(req.name)) {
      throw new Error(`An MCP server named "${req.name}" already exists`);
    }

    const id = generateUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO app_mcp_servers
          (id, name, description, source_type, command, args, env, url, headers, enabled, source, source_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        req.name,
        req.description ?? null,
        req.sourceType,
        req.command ?? null,
        req.args !== undefined ? JSON.stringify(req.args) : null,
        req.env !== undefined ? JSON.stringify(req.env) : null,
        req.url ?? null,
        req.headers !== undefined ? JSON.stringify(req.headers) : null,
        (req.enabled ?? true) ? 1 : 0,
        source,
        req.sourcePath ?? null,
        now,
        now
      );

    this.reactiveDb.notifyChange('app_mcp_servers');
    return this.get(id)!;
  }

  /**
   * List all entries for a given `sourcePath`. Used by `McpImportService`
   * to diff the set of imported rows against what's currently declared in
   * a `.mcp.json` file on disk, so that removed entries can be pruned.
   */
  listBySourcePath(sourcePath: string): AppMcpServer[] {
    const rows = this.db
      .prepare(`SELECT * FROM app_mcp_servers WHERE source_path = ? AND source = 'imported'`)
      .all(sourcePath) as AppMcpServerRow[];
    return rows.map(rowToServer);
  }

  /**
   * List all `source='imported'` entries. Used by `McpImportService` to find
   * stale rows whose originating file no longer exists (e.g. the workspace
   * was removed) and prune them.
   */
  listImported(): AppMcpServer[] {
    const rows = this.db
      .prepare(`SELECT * FROM app_mcp_servers WHERE source = 'imported'`)
      .all() as AppMcpServerRow[];
    return rows.map(rowToServer);
  }

  /**
   * Look up an imported entry by its unique `(sourcePath, name)` key.
   * Returns null when no matching imported row exists.
   */
  getImportedByPathAndName(sourcePath: string, name: string): AppMcpServer | null {
    const row = this.db
      .prepare(
        `SELECT * FROM app_mcp_servers WHERE source = 'imported' AND source_path = ? AND name = ?`
      )
      .get(sourcePath, name) as AppMcpServerRow | undefined;
    return row ? rowToServer(row) : null;
  }

  /**
   * Get a server entry by ID. Returns null if not found.
   */
  get(id: string): AppMcpServer | null {
    const row = this.db.prepare(`SELECT * FROM app_mcp_servers WHERE id = ?`).get(id) as
      | AppMcpServerRow
      | undefined;
    return row ? rowToServer(row) : null;
  }

  /**
   * Get a server entry by name. Returns null if not found.
   */
  getByName(name: string): AppMcpServer | null {
    const row = this.db.prepare(`SELECT * FROM app_mcp_servers WHERE name = ?`).get(name) as
      | AppMcpServerRow
      | undefined;
    return row ? rowToServer(row) : null;
  }

  /**
   * List all MCP server entries, ordered by created_at (NULLs last).
   */
  list(): AppMcpServer[] {
    const rows = this.db
      .prepare(`SELECT * FROM app_mcp_servers ORDER BY created_at IS NULL, created_at ASC`)
      .all() as AppMcpServerRow[];
    return rows.map(rowToServer);
  }

  /**
   * List only enabled MCP server entries, ordered by created_at (NULLs last).
   */
  listEnabled(): AppMcpServer[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM app_mcp_servers WHERE enabled = 1 ORDER BY created_at IS NULL, created_at ASC`
      )
      .all() as AppMcpServerRow[];
    return rows.map(rowToServer);
  }

  /**
   * Update an existing MCP server entry. Returns the updated entry or null if not found.
   * Throws if the new name is already taken by another entry, or if sourceType is invalid.
   */
  update(id: string, updates: Omit<UpdateAppMcpServerRequest, 'id'>): AppMcpServer | null {
    const existing = this.get(id);
    if (!existing) return null;

    if (updates.name !== undefined && this.isNameTaken(updates.name, id)) {
      throw new Error(`An MCP server named "${updates.name}" already exists`);
    }

    if (updates.sourceType !== undefined) {
      validateSourceType(updates.sourceType);
    }

    if (updates.source !== undefined) {
      validateSource(updates.source);
    }

    const now = Date.now();
    const fields: string[] = [];
    const values: SQLiteValue[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if ('description' in updates) {
      fields.push('description = ?');
      values.push(updates.description ?? null);
    }
    if (updates.sourceType !== undefined) {
      fields.push('source_type = ?');
      values.push(updates.sourceType);
    }
    if ('command' in updates) {
      fields.push('command = ?');
      values.push(updates.command ?? null);
    }
    if ('args' in updates) {
      fields.push('args = ?');
      values.push(updates.args !== undefined ? JSON.stringify(updates.args) : null);
    }
    if ('env' in updates) {
      fields.push('env = ?');
      values.push(updates.env !== undefined ? JSON.stringify(updates.env) : null);
    }
    if ('url' in updates) {
      fields.push('url = ?');
      values.push(updates.url ?? null);
    }
    if ('headers' in updates) {
      fields.push('headers = ?');
      values.push(updates.headers !== undefined ? JSON.stringify(updates.headers) : null);
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.source !== undefined) {
      fields.push('source = ?');
      values.push(updates.source);
    }
    if ('sourcePath' in updates) {
      fields.push('source_path = ?');
      values.push(updates.sourcePath ?? null);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(now);
      values.push(id);
      this.db
        .prepare(`UPDATE app_mcp_servers SET ${fields.join(', ')} WHERE id = ?`)
        .run(...values);
      this.reactiveDb.notifyChange('app_mcp_servers');
    }

    return this.get(id);
  }

  /**
   * Delete an MCP server entry. Returns true if a row was deleted.
   */
  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM app_mcp_servers WHERE id = ?`).run(id);
    const deleted = result.changes > 0;
    if (deleted) {
      this.reactiveDb.notifyChange('app_mcp_servers');
    }
    return deleted;
  }
}
