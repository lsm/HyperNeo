/**
 * McpImportService
 *
 * Scans `.mcp.json` files (project-level and user-level `~/.claude/.mcp.json`)
 * and imports their `mcpServers` entries into the `app_mcp_servers` registry
 * as rows with `source='imported'` and `sourcePath=<absolute path>`.
 *
 * Part of the MCP config unification work (docs/plans/unify-mcp-config-model).
 *
 * Design contract:
 *   - Dedupe key is `(sourcePath, name)`. Re-scanning the same file is a no-op
 *     for unchanged entries, an update for changed ones, and a remove+add for
 *     renames (old name disappears → pruned; new name appears → inserted).
 *   - Imported rows land with `enabled: false`. The user must explicitly flip
 *     them to `true` via the MCP Servers UI before they are injected into any
 *     session. This matches the M2 acceptance criteria in the plan doc.
 *   - Scanning is never triggered from `session.create` — the service is only
 *     invoked on daemon startup, on `workspace.add`, and on the explicit
 *     `settings.mcp.refreshImports` RPC. Keeping scans off the session hot path
 *     avoids a hidden fd/stat dependency and makes the registry the single
 *     source the session builder reads from.
 *   - Malformed JSON / I/O failures are logged and skipped; they never throw
 *     past the service boundary. A broken `.mcp.json` in one workspace must
 *     not block daemon startup or unrelated refreshes.
 *   - When a `.mcp.json` is deleted (file no longer exists) all `source='imported'`
 *     rows tied to that path are pruned. Used both on explicit per-file refresh
 *     (`refreshFromFile` with a missing file) and on the bulk `pruneMissingFiles`
 *     sweep that runs as part of `refreshAll`.
 *
 * Future (M3+): when an imported row is edited by the user via the registry UI
 * its `source` can be transitioned to `'user'` to "claim" it — subsequent
 * scans of that `.mcp.json` will no longer touch the row. The repository
 * supports this transition today via `update({ source: 'user' })`.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import type { AppMcpServer, CreateAppMcpServerRequest } from '@hyperneo/shared';
import type { Database } from '../../storage/database';
import { Logger } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-file outcome summary. Returned from `refreshFromFile` and collected by
 * `refreshAll` so callers (RPC handlers, tests) can inspect what changed.
 */
export interface ImportResult {
  /** Absolute path of the `.mcp.json` that was scanned. */
  sourcePath: string;
  /** `'ok'` if the file existed and parsed; `'missing'` if not present;
   *  `'malformed'` if JSON parse or schema validation failed. */
  status: 'ok' | 'missing' | 'malformed';
  /** Number of new rows inserted. */
  added: number;
  /** Number of existing rows updated in place (config fields changed). */
  updated: number;
  /** Number of rows removed because their name disappeared from the file. */
  removed: number;
  /** Human-readable error string for `'malformed'` results. */
  error?: string;
}

/** Parsed shape of an `.mcp.json` entry. Only the fields we care about. */
interface McpJsonEntry {
  type?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferSourceType(entry: McpJsonEntry): 'stdio' | 'sse' | 'http' {
  if (entry.type) return entry.type;
  // Claude Code convention: absence of `type` implies stdio if command is set,
  // or http/sse if only url is set (we default to http here; sse is rare enough
  // that it must be declared explicitly).
  if (entry.url && !entry.command) return 'http';
  return 'stdio';
}

/**
 * Produce a stable, comparable representation of the DB row fields we care
 * about when deciding whether an existing imported row needs updating.
 */
function fieldsEqual(row: AppMcpServer, req: CreateAppMcpServerRequest): boolean {
  const norm = (v: unknown): string => JSON.stringify(v ?? null);
  return (
    row.sourceType === req.sourceType &&
    (row.command ?? null) === (req.command ?? null) &&
    norm(row.args) === norm(req.args) &&
    norm(row.env) === norm(req.env) &&
    (row.url ?? null) === (req.url ?? null) &&
    norm(row.headers) === norm(req.headers) &&
    (row.description ?? null) === (req.description ?? null)
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class McpImportService {
  private readonly log: Logger;

  constructor(private readonly db: Database) {
    this.log = new Logger('mcp-import');
  }

  /**
   * Scan a single `.mcp.json` file and reconcile the `source='imported'` rows
   * tied to it.
   *
   * Contract:
   *   - `absolutePath` must be absolute. Relative paths throw synchronously —
   *     this is a programmer error, not a runtime condition.
   *   - Missing file → prune all imported rows for this path, return
   *     `status: 'missing'`.
   *   - Malformed JSON or schema → log + return `status: 'malformed'`.
   *     Existing imported rows are left untouched (we don't know which to
   *     remove without a valid file — a parse error shouldn't nuke data).
   *   - Valid file → upsert each entry, prune any row whose name is no longer
   *     present in the file.
   */
  refreshFromFile(absolutePath: string): ImportResult {
    if (!isAbsolute(absolutePath)) {
      throw new Error(
        `McpImportService.refreshFromFile requires absolute path, got: ${absolutePath}`
      );
    }

    const result: ImportResult = {
      sourcePath: absolutePath,
      status: 'ok',
      added: 0,
      updated: 0,
      removed: 0,
    };

    if (!existsSync(absolutePath)) {
      result.status = 'missing';
      result.removed = this.pruneBySourcePath(absolutePath);
      return result;
    }

    let raw: string;
    try {
      raw = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
      result.status = 'malformed';
      result.error = `read failed: ${err instanceof Error ? err.message : String(err)}`;
      this.log.warn(`[mcp-import] ${absolutePath}: ${result.error}`);
      return result;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      result.status = 'malformed';
      result.error = `parse failed: ${err instanceof Error ? err.message : String(err)}`;
      this.log.warn(`[mcp-import] ${absolutePath}: ${result.error}`);
      return result;
    }

    const entries = this.extractEntries(parsed);
    if (entries === null) {
      result.status = 'malformed';
      result.error = 'missing or invalid "mcpServers" object';
      this.log.warn(`[mcp-import] ${absolutePath}: ${result.error}`);
      return result;
    }

    const declaredNames = new Set<string>();
    for (const [name, entry] of Object.entries(entries)) {
      const req = this.buildCreateRequest(name, entry, absolutePath);
      if (!req) {
        this.log.warn(`[mcp-import] ${absolutePath}: skipping "${name}" — missing required fields`);
        continue;
      }
      declaredNames.add(name);

      const existing = this.db.appMcpServers.getImportedByPathAndName(absolutePath, name);
      if (!existing) {
        // New imported row. Fail soft on name collision with a non-imported row
        // (the repository enforces global name uniqueness); we log and skip so a
        // user's `.mcp.json` can never clobber a `user`/`builtin` row silently.
        const collision = this.db.appMcpServers.getByName(name);
        if (collision) {
          this.log.warn(
            `[mcp-import] ${absolutePath}: skipping "${name}" — name already taken by ${collision.source} entry`
          );
          continue;
        }
        try {
          this.db.appMcpServers.create(req);
          result.added += 1;
        } catch (err) {
          this.log.warn(
            `[mcp-import] ${absolutePath}: failed to create "${name}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
        continue;
      }

      // Existing imported row — update in place if config fields drifted.
      if (!fieldsEqual(existing, req)) {
        try {
          this.db.appMcpServers.update(existing.id, {
            description: req.description,
            sourceType: req.sourceType,
            command: req.command,
            args: req.args,
            env: req.env,
            url: req.url,
            headers: req.headers,
          });
          result.updated += 1;
        } catch (err) {
          this.log.warn(
            `[mcp-import] ${absolutePath}: failed to update "${name}": ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // Prune imported rows for this sourcePath whose name is no longer declared.
    for (const row of this.db.appMcpServers.listBySourcePath(absolutePath)) {
      if (!declaredNames.has(row.name)) {
        if (this.db.appMcpServers.delete(row.id)) {
          result.removed += 1;
        }
      }
    }

    return result;
  }

  /**
   * Scan every known `.mcp.json`:
   *   - `${workspacePath}/.mcp.json` for each workspace in `workspacePaths`
   *   - `${homedir()}/.claude/.mcp.json` (user-level, always)
   *
   * Also prunes any `source='imported'` rows whose `sourcePath` file no
   * longer exists on disk — handles the case where a workspace was removed
   * from history, or a `.mcp.json` was deleted between daemon runs.
   *
   * Never throws — per-file failures are captured in the result array.
   */
  refreshAll(workspacePaths: readonly string[]): ImportResult[] {
    const targets = this.collectScanTargets(workspacePaths);

    const results: ImportResult[] = [];
    for (const target of targets) {
      try {
        results.push(this.refreshFromFile(target));
      } catch (err) {
        // Defensive: refreshFromFile is designed not to throw, but guard anyway
        // so one poisoned path can't stop the rest of the sweep.
        this.log.error(
          `[mcp-import] ${target}: unexpected error: ${err instanceof Error ? err.message : String(err)}`
        );
        results.push({
          sourcePath: target,
          status: 'malformed',
          added: 0,
          updated: 0,
          removed: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Second sweep: prune imported rows whose sourcePath isn't in `targets`
    // AND whose file no longer exists. This catches rows left behind when a
    // workspace was removed from history entirely.
    const targetSet = new Set(targets);
    for (const row of this.db.appMcpServers.listImported()) {
      if (!row.sourcePath) continue;
      if (targetSet.has(row.sourcePath)) continue; // already handled above
      if (!existsSync(row.sourcePath)) {
        this.db.appMcpServers.delete(row.id);
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Build the ordered list of absolute `.mcp.json` paths to scan. */
  private collectScanTargets(workspacePaths: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const wp of workspacePaths) {
      if (!wp) continue;
      const abs = resolve(wp);
      const target = join(abs, '.mcp.json');
      if (!seen.has(target)) {
        seen.add(target);
        out.push(target);
      }
    }

    // User-level `~/.claude/.mcp.json` — matches the `SettingsManager` read
    // path. Honour `TEST_USER_SETTINGS_DIR` so tests can point this at a
    // temp dir without touching the real home directory.
    const userMcpDir = process.env.TEST_USER_SETTINGS_DIR || homedir();
    const userMcp = join(userMcpDir, '.mcp.json');
    if (!seen.has(userMcp)) {
      seen.add(userMcp);
      out.push(userMcp);
    }

    return out;
  }

  /**
   * Parse the top-level of a `.mcp.json` document and return its
   * `mcpServers` object, or `null` if the shape is invalid.
   */
  private extractEntries(parsed: unknown): Record<string, McpJsonEntry> | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const doc = parsed as Record<string, unknown>;
    const servers = doc.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return null;
    }
    return servers as Record<string, McpJsonEntry>;
  }

  /**
   * Convert one `.mcp.json` entry into a repo create request. Returns `null`
   * if the entry is missing fields required for its source type — the caller
   * logs + skips so one bad entry doesn't nuke the rest of the file.
   */
  private buildCreateRequest(
    name: string,
    entry: McpJsonEntry,
    sourcePath: string
  ): CreateAppMcpServerRequest | null {
    const sourceType = inferSourceType(entry);

    if (sourceType === 'stdio') {
      if (!entry.command || typeof entry.command !== 'string') return null;
      return {
        name,
        sourceType: 'stdio',
        command: entry.command,
        ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
        ...(entry.env && typeof entry.env === 'object' ? { env: entry.env } : {}),
        enabled: false,
        source: 'imported',
        sourcePath,
      };
    }

    // sse / http
    if (!entry.url || typeof entry.url !== 'string') return null;
    return {
      name,
      sourceType,
      url: entry.url,
      ...(entry.headers && typeof entry.headers === 'object' ? { headers: entry.headers } : {}),
      enabled: false,
      source: 'imported',
      sourcePath,
    };
  }

  /**
   * Delete every `source='imported'` row tied to `sourcePath`. Returns the
   * number of rows removed. Used when a `.mcp.json` is missing at refresh time.
   */
  private pruneBySourcePath(sourcePath: string): number {
    let removed = 0;
    for (const row of this.db.appMcpServers.listBySourcePath(sourcePath)) {
      if (this.db.appMcpServers.delete(row.id)) {
        removed += 1;
      }
    }
    return removed;
  }
}
