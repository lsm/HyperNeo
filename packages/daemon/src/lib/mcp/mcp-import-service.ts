import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import type { AppMcpServer, CreateAppMcpServerRequest } from '@hyperneo/shared';
import type { Database } from '../../storage/database.ts';
import { Logger } from '../logger.ts';

export interface ImportResult {
  sourcePath: string;
  status: 'ok' | 'missing' | 'malformed';
  added: number;
  updated: number;
  removed: number;
  error?: string;
}

export interface RefreshAllResult {
  results: ImportResult[];
  orphanPruned: number;
}

interface McpJsonEntry {
  type?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function inferSourceType(entry: McpJsonEntry): 'stdio' | 'sse' | 'http' {
  if (entry.type) return entry.type;
  if (entry.url && !entry.command) return 'http';
  return 'stdio';
}

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

export class McpImportService {
  private readonly log: Logger;

  constructor(
    private readonly db: Database,
    private readonly homeDirOverride?: string
  ) {
    this.log = new Logger('mcp-import');
  }

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

    for (const row of this.db.appMcpServers.listBySourcePath(absolutePath)) {
      if (!declaredNames.has(row.name)) {
        if (this.db.appMcpServers.delete(row.id)) {
          result.removed += 1;
        }
      }
    }

    return result;
  }

  refreshAll(workspacePaths: readonly string[]): RefreshAllResult {
    const targets = this.collectScanTargets(workspacePaths);

    const results: ImportResult[] = [];
    for (const target of targets) {
      try {
        results.push(this.refreshFromFile(target));
      } catch (err) {
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

    const targetSet = new Set(targets);
    let orphanPruned = 0;
    for (const row of this.db.appMcpServers.listImported()) {
      if (!row.sourcePath) continue;
      if (targetSet.has(row.sourcePath)) continue;
      if (!existsSync(row.sourcePath)) {
        if (this.db.appMcpServers.delete(row.id)) {
          orphanPruned += 1;
        }
      }
    }

    return { results, orphanPruned };
  }

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

    const userBaseDir =
      process.env.TEST_USER_SETTINGS_DIR || join(this.homeDirOverride ?? homedir(), '.claude');
    const userMcp = join(userBaseDir, '.mcp.json');
    if (!seen.has(userMcp)) {
      seen.add(userMcp);
      out.push(userMcp);
    }

    return out;
  }

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
