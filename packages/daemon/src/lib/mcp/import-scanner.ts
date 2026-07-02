/**
 * MCP Import Scanner
 *
 * Scans on-disk `.mcp.json` files and upserts/removes rows in the
 * `app_mcp_servers` registry tagged with `source = 'imported'`. This is
 * the minimum implementation for M2 — it gives the M4 space settings UI
 * a "Refresh imports" button that keeps the imported registry set in
 * sync with whatever Claude Code picked up from the project.
 *
 * A successful scan is idempotent:
 *   - Existing imported rows with a matching `(name, sourcePath)` are
 *     updated in place (command/args/env/url/headers).
 *   - New imported entries are inserted with `enabled=true` so they
 *     show up immediately in the space settings UI.
 *   - Imported rows whose `sourcePath` was scanned but no longer appears
 *     in any scanned file are deleted.
 *
 * Non-imported rows (builtin/user) are never touched.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AppMcpServer,
  AppMcpServerSourceType,
  CreateAppMcpServerRequest,
  UpdateAppMcpServerRequest,
} from '@hyperneo/shared';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import { Logger } from '../logger';

const log = new Logger('mcp-import-scanner');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpJsonStdioEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpJsonUrlEntry {
  type?: 'sse' | 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

type McpJsonEntry = McpJsonStdioEntry | McpJsonUrlEntry;

interface McpJsonFile {
  mcpServers?: Record<string, McpJsonEntry>;
}

export interface ImportScanResult {
  /** Number of imported rows inserted or updated. */
  imported: number;
  /** Number of imported rows removed because the scanned source no longer lists them. */
  removed: number;
  /** Human-readable notes (e.g. files not found, parse errors). */
  notes: string[];
}

export interface ImportScanOptions {
  /** Paths of `.mcp.json` files to scan. Missing files are quietly skipped. */
  mcpJsonPaths: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferSourceType(entry: McpJsonEntry): AppMcpServerSourceType | null {
  if ('type' in entry && entry.type) {
    if (entry.type === 'stdio' || entry.type === 'sse' || entry.type === 'http') {
      return entry.type;
    }
  }
  if ('command' in entry && entry.command) return 'stdio';
  if ('url' in entry && entry.url) return 'http';
  return null;
}

function entryShallowEqual(a: AppMcpServer, b: CreateAppMcpServerRequest): boolean {
  if (a.sourceType !== b.sourceType) return false;
  if ((a.command ?? null) !== (b.command ?? null)) return false;
  if ((a.url ?? null) !== (b.url ?? null)) return false;
  const aArgs = JSON.stringify(a.args ?? []);
  const bArgs = JSON.stringify(b.args ?? []);
  if (aArgs !== bArgs) return false;
  const aEnv = JSON.stringify(a.env ?? {});
  const bEnv = JSON.stringify(b.env ?? {});
  if (aEnv !== bEnv) return false;
  const aHeaders = JSON.stringify(a.headers ?? {});
  const bHeaders = JSON.stringify(b.headers ?? {});
  if (aHeaders !== bHeaders) return false;
  return true;
}

async function readMcpJsonSafe(
  path: string,
  notes: string[]
): Promise<Record<string, McpJsonEntry> | null> {
  try {
    await stat(path);
  } catch {
    // File missing — quietly skip; not every workspace has a .mcp.json.
    return null;
  }
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as McpJsonFile;
    return parsed.mcpServers ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`${path}: parse error — ${msg}`);
    log.warn(`readMcpJsonSafe: parse error for ${path}: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan each `.mcp.json` path and reconcile imported rows in the registry.
 * Returns a summary of how many rows were inserted/updated vs. removed.
 *
 * Only imported rows are touched: user-authored or builtin rows are
 * preserved untouched, and any `source='imported'` row whose sourcePath
 * was scanned but whose name is missing from the file gets deleted.
 */
export async function scanMcpImports(
  repo: AppMcpServerRepository,
  options: ImportScanOptions
): Promise<ImportScanResult> {
  const notes: string[] = [];
  let imported = 0;
  let removed = 0;

  // Map by (sourcePath, name) for quick lookup of existing rows.
  const existingImported = repo.listImported();
  const existingByKey = new Map<string, AppMcpServer>();
  for (const row of existingImported) {
    if (row.sourcePath) {
      existingByKey.set(`${row.sourcePath}::${row.name}`, row);
    }
  }

  // Track which (sourcePath, name) keys appear in the scanned files so we
  // can delete imported rows whose source file was scanned but no longer
  // lists them. Files that fail to read (parse errors, missing) are NOT
  // marked scanned — rows tied to them are left alone.
  const scannedPaths = new Set<string>();
  const seenKeys = new Set<string>();

  for (const mcpJsonPath of options.mcpJsonPaths) {
    const servers = await readMcpJsonSafe(mcpJsonPath, notes);
    if (servers === null) continue;
    scannedPaths.add(mcpJsonPath);

    for (const [name, entry] of Object.entries(servers)) {
      const sourceType = inferSourceType(entry);
      if (!sourceType) {
        notes.push(`${mcpJsonPath}: server "${name}" has unknown shape — skipped`);
        continue;
      }

      const req: CreateAppMcpServerRequest = {
        name,
        sourceType,
        enabled: true,
        source: 'imported',
        sourcePath: mcpJsonPath,
        ...('command' in entry && entry.command ? { command: entry.command } : {}),
        ...('args' in entry && entry.args ? { args: entry.args } : {}),
        ...('env' in entry && entry.env ? { env: entry.env } : {}),
        ...('url' in entry && entry.url ? { url: entry.url } : {}),
        ...('headers' in entry && entry.headers ? { headers: entry.headers } : {}),
      };

      const key = `${mcpJsonPath}::${name}`;
      seenKeys.add(key);

      const existing = existingByKey.get(key);
      if (existing) {
        if (!entryShallowEqual(existing, req)) {
          const updates: Omit<UpdateAppMcpServerRequest, 'id'> = {
            sourceType: req.sourceType,
            command: req.command,
            args: req.args,
            env: req.env,
            url: req.url,
            headers: req.headers,
          };
          repo.update(existing.id, updates);
          imported += 1;
        }
        continue;
      }

      // Insert if no row exists. Check for a name collision with a non-imported
      // entry — if one exists, skip with a note so user/builtin rows aren't
      // clobbered.
      const collision = repo.getByName(name);
      if (collision) {
        notes.push(
          `${mcpJsonPath}: server "${name}" already exists as "${collision.source}" — import skipped`
        );
        continue;
      }
      repo.create(req);
      imported += 1;
    }
  }

  // Delete imported rows whose source file was scanned but which no longer
  // appears in that file.
  for (const row of existingImported) {
    if (!row.sourcePath) continue;
    if (!scannedPaths.has(row.sourcePath)) continue;
    const key = `${row.sourcePath}::${row.name}`;
    if (!seenKeys.has(key)) {
      repo.delete(row.id);
      removed += 1;
    }
  }

  return { imported, removed, notes };
}

/**
 * Build a de-duplicated list of `.mcp.json` paths to scan:
 *   - The user-level `~/.claude/.mcp.json` (if HOME is set).
 *   - Every unique `workspacePath` provided, with `.mcp.json` joined.
 *   - Optional additional explicit paths (e.g. from a test harness).
 */
export function buildMcpJsonPaths(opts: {
  workspacePaths: string[];
  homeDir?: string;
  additional?: string[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };

  if (opts.homeDir) {
    push(join(opts.homeDir, '.claude', '.mcp.json'));
  }
  for (const wp of opts.workspacePaths) {
    if (wp) push(join(wp, '.mcp.json'));
  }
  for (const extra of opts.additional ?? []) {
    if (extra) push(extra);
  }
  return out;
}
