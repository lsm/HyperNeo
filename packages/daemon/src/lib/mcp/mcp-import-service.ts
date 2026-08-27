import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  AppMcpServer,
  CreateAppMcpServerRequest,
  UpdateAppMcpServerRequest,
} from '@hyperneo/shared';
import type { Database } from '../../storage/database.ts';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { SpaceWorkspaceRepository } from '../../storage/repositories/space-workspace-repository.ts';
import { Logger } from '../logger.ts';
import { resolveWorkspaceMcpServerName } from './mcp-server-namespace.ts';

export interface ImportResult {
  sourcePath: string;
  status: 'ok' | 'missing' | 'malformed' | 'failed';
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

interface McpImportSource {
  path: string;
  label?: string;
}

interface McpImportTarget {
  path: string;
  label: string;
}

interface McpSourceDeclaration {
  target: McpImportTarget;
  status: 'ok' | 'missing' | 'malformed';
  error?: string;
  entries?: Record<string, McpJsonEntry>;
  rawNames?: Record<string, string>;
}

interface RefreshMcpImportsCtx {
  db: Database;
  sources: McpImportSource[];
  homeDirOverride?: string;
  log: Logger;
  service: McpImportService;
  targets?: McpImportTarget[];
  reserved?: Set<string>;
  blocked?: Set<string>;
  declarations?: McpSourceDeclaration[];
  results?: ImportResult[];
  orphanPruned?: number;
  skipOrphanPrune?: boolean;
  includeUserConfig?: boolean;
  result?: RefreshAllResult;
}

function inferSourceType(entry: McpJsonEntry | null | undefined): 'stdio' | 'sse' | 'http' | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  if (entry.type) {
    if (entry.type === 'stdio' || entry.type === 'sse' || entry.type === 'http') {
      return entry.type;
    }
    return null;
  }
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

  refreshAll(
    sources?: readonly (string | McpImportSource)[],
    opts?: { skipOrphanPrune?: boolean; includeUserConfig?: boolean }
  ): RefreshAllResult {
    let mcpSources: McpImportSource[];
    if (sources === undefined) {
      try {
        mcpSources = this.collectMcpImportSources();
      } catch (err) {
        this.log.warn(
          `[mcp-import] workspace registry collection failed, aborting refresh: ${err instanceof Error ? err.message : String(err)}`
        );
        return { results: [], orphanPruned: 0 };
      }
    } else {
      mcpSources = sources.map((source) =>
        typeof source === 'string' ? { path: source } : source
      );
    }

    const ctx = runRefreshMcpImports({
      db: this.db,
      sources: mcpSources,
      homeDirOverride: this.homeDirOverride,
      log: this.log,
      service: this,
      skipOrphanPrune: opts?.skipOrphanPrune,
      includeUserConfig: opts?.includeUserConfig,
    });
    return ctx.result ?? { results: [], orphanPruned: 0 };
  }

  refreshAllForPath(absoluteWorkspacePath: string): ImportResult {
    if (!isAbsolute(absoluteWorkspacePath)) {
      throw new Error(
        `McpImportService.refreshAllForPath requires absolute path, got: ${absoluteWorkspacePath}`
      );
    }

    let mcpSources: McpImportSource[];
    try {
      mcpSources = this.collectMcpImportSources();
    } catch (err) {
      this.log.warn(
        `[mcp-import] workspace registry collection failed, falling back to bare import: ${err instanceof Error ? err.message : String(err)}`
      );
      mcpSources = [];
    }

    const source = mcpSources.find((s) => {
      try {
        return resolve(s.path) === absoluteWorkspacePath;
      } catch {
        return false;
      }
    }) ?? { path: absoluteWorkspacePath, label: '' };

    const targetPath = join(absoluteWorkspacePath, '.mcp.json');
    const result = this.refreshAll([source], {
      skipOrphanPrune: true,
      includeUserConfig: false,
    });
    return (
      result.results.find((r) => r.sourcePath === targetPath) ?? {
        sourcePath: targetPath,
        status: 'ok',
        added: 0,
        updated: 0,
        removed: 0,
      }
    );
  }

  private collectMcpImportSources(): McpImportSource[] {
    const rawDb = this.db.getDatabase?.();
    if (!rawDb) return [];

    const spaceRepo = new SpaceRepository(rawDb);
    const workspaceRepo = new SpaceWorkspaceRepository(rawDb);
    const seen = new Set<string>();
    const out: McpImportSource[] = [];

    for (const space of spaceRepo.listSpaces(true)) {
      for (const ws of workspaceRepo.listBySpace(space.id)) {
        if (!ws.path) continue;
        try {
          const abs = resolve(ws.path);
          if (seen.has(abs)) continue;
          seen.add(abs);
          const label = ws.label?.trim() || basename(abs);
          out.push({ path: abs, label });
        } catch {}
      }

      if (space.workspacePath) {
        try {
          const abs = resolve(space.workspacePath);
          if (seen.has(abs)) continue;
          seen.add(abs);
          out.push({ path: abs, label: basename(abs) });
        } catch {}
      }
    }

    const historyRepo = this.db.workspaceHistory;
    if (historyRepo) {
      const rows = historyRepo.listAll ? historyRepo.listAll() : historyRepo.list(1000);
      for (const row of rows) {
        if (!row.path) continue;
        try {
          const abs = resolve(row.path);
          if (seen.has(abs)) continue;
          seen.add(abs);
          out.push({ path: abs, label: '' });
        } catch {}
      }
    }

    return out;
  }

  extractEntries(parsed: unknown): Record<string, McpJsonEntry> | null {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const doc = parsed as Record<string, unknown>;
    const servers = doc.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return null;
    }
    const out: Record<string, McpJsonEntry> = Object.create(null);
    const serverRecord = servers as Record<string, unknown>;
    for (const key of Object.keys(serverRecord)) {
      out[key] = serverRecord[key] as McpJsonEntry;
    }
    return out;
  }

  buildCreateRequest(
    name: string,
    entry: McpJsonEntry | null | undefined,
    sourcePath: string
  ): CreateAppMcpServerRequest | null {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const sourceType = inferSourceType(entry);
    if (sourceType === null) return null;

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

function buildMcpTargets(ctx: RefreshMcpImportsCtx): RefreshMcpImportsCtx {
  const seen = new Set<string>();
  const targets: McpImportTarget[] = [];

  const userBaseDir =
    process.env.TEST_USER_SETTINGS_DIR || join(ctx.homeDirOverride ?? homedir(), '.claude');
  const userMcp = join(userBaseDir, '.mcp.json');

  if (ctx.includeUserConfig !== false) {
    seen.add(userMcp);
    targets.push({ path: userMcp, label: '' });
  }

  for (const source of ctx.sources) {
    if (!source.path) continue;
    try {
      const abs = resolve(source.path);
      const targetPath = join(abs, '.mcp.json');
      if (seen.has(targetPath)) continue;
      seen.add(targetPath);
      const label = targetPath === userMcp ? '' : (source.label ?? '');
      targets.push({ path: targetPath, label });
    } catch {}
  }

  targets.sort((a, b) => a.path.localeCompare(b.path));

  return { ...ctx, targets };
}

function buildResolvedBaseName(label: string, serverName: string): string {
  return label ? `${label}:${serverName}` : serverName;
}

function hasNumericSuffix(serverName: string): boolean {
  return /:[1-9]\d*$/.test(serverName);
}

function matchExistingRank(
  storedName: string,
  serverName: string,
  label: string,
  allServerNames?: ReadonlySet<string>
): number {
  const base = buildResolvedBaseName(label, serverName);
  if (storedName === base) return 0;
  const prefix = `${base}:`;
  if (storedName.startsWith(prefix)) {
    const suffix = storedName.slice(prefix.length);
    if (/^(?:[2-9]|[1-9]\d+)$/.test(suffix)) {
      if (allServerNames?.has(`${serverName}:${suffix}`)) {
        return -1;
      }
      return parseInt(suffix, 10);
    }
  }

  if (label === '' && serverName) {
    const rawSegments = serverName.split(':');
    const storedSegments = storedName.split(':');
    if (storedSegments.length > rawSegments.length) {
      const tail = storedSegments.slice(-rawSegments.length).join(':');
      if (tail === serverName) return 1;
    }
    if (storedSegments.length > rawSegments.length + 1) {
      const last = storedSegments[storedSegments.length - 1];
      if (/^(?:[2-9]|[1-9]\d+)$/.test(last)) {
        const stripped = storedSegments.slice(0, -1);
        const tail = stripped.slice(-rawSegments.length).join(':');
        if (tail === serverName) {
          if (allServerNames?.has(`${serverName}:${last}`)) {
            return -1;
          }
          return 1 + parseInt(last, 10);
        }
      }
    }
  }

  return -1;
}

function findBestExistingMatch(
  serverName: string,
  label: string,
  existingByName: Map<string, AppMcpServer>,
  usedExistingNames: Set<string>,
  allServerNames?: ReadonlySet<string>
): AppMcpServer | undefined {
  let best: AppMcpServer | undefined;
  let bestRank = Infinity;
  for (const [name, row] of existingByName) {
    if (usedExistingNames.has(name)) continue;
    const rank = matchExistingRank(name, serverName, label, allServerNames);
    if (rank >= 0 && rank < bestRank) {
      best = row;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return best;
}

function findLegacyMatch(
  rawName: string,
  existingByName: Map<string, AppMcpServer>,
  allServerNames?: ReadonlySet<string>,
  protectedNames?: ReadonlySet<string>
): AppMcpServer | undefined {
  let best: AppMcpServer | undefined;
  let bestRank = Infinity;
  for (const [name, row] of existingByName) {
    if (protectedNames?.has(name)) continue;
    const rank = matchExistingRank(name, rawName, '', allServerNames);
    if (rank >= 0 && rank < bestRank) {
      best = row;
      bestRank = rank;
      if (rank === 0) break;
    }
  }
  return best;
}

function loadMcpExistingNames(ctx: RefreshMcpImportsCtx): RefreshMcpImportsCtx {
  const all = ctx.db.appMcpServers.list();
  const reserved = new Set<string>(all.map((row) => row.name));
  const blocked = new Set<string>(
    all.filter((row) => row.source !== 'imported').map((row) => row.name)
  );
  return { ...ctx, reserved, blocked };
}

function extractMcpSources(ctx: RefreshMcpImportsCtx): RefreshMcpImportsCtx {
  const declarations: McpSourceDeclaration[] = [];
  const results: ImportResult[] = [];

  for (const target of ctx.targets ?? []) {
    const result: ImportResult = {
      sourcePath: target.path,
      status: 'ok',
      added: 0,
      updated: 0,
      removed: 0,
    };

    if (!existsSync(target.path)) {
      result.status = 'missing';
      declarations.push({ target, status: 'missing' });
      results.push(result);
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(target.path, 'utf-8');
    } catch (err) {
      result.status = 'malformed';
      result.error = `read failed: ${err instanceof Error ? err.message : String(err)}`;
      ctx.log.warn(`[mcp-import] ${target.path}: ${result.error}`);
      declarations.push({ target, status: 'malformed', error: result.error });
      results.push(result);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      result.status = 'malformed';
      result.error = `parse failed: ${err instanceof Error ? err.message : String(err)}`;
      ctx.log.warn(`[mcp-import] ${target.path}: ${result.error}`);
      declarations.push({ target, status: 'malformed', error: result.error });
      results.push(result);
      continue;
    }

    const entriesByServerName = ctx.service.extractEntries(parsed);
    if (entriesByServerName === null) {
      result.status = 'malformed';
      result.error = 'missing or invalid "mcpServers" object';
      ctx.log.warn(`[mcp-import] ${target.path}: ${result.error}`);
      declarations.push({ target, status: 'malformed', error: result.error });
      results.push(result);
      continue;
    }

    const existingRows = ctx.db.appMcpServers.listBySourcePath(target.path);
    const existingByName = new Map(existingRows.map((row) => [row.name, row]));
    const targetReserved = new Set(ctx.reserved ?? new Set<string>());
    const usedExistingNames = new Set<string>();

    const validRaws: [string, McpJsonEntry][] = [];
    const allServerNames = new Set<string>();
    for (const [serverName, rawEntry] of Object.entries(entriesByServerName)) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        ctx.log.warn(`[mcp-import] ${target.path}: skipping "${serverName}" — invalid entry`);
        continue;
      }
      validRaws.push([serverName, rawEntry]);
      allServerNames.add(serverName);
    }

    const allBases = new Set<string>();
    for (const [serverName] of validRaws) {
      allBases.add(buildResolvedBaseName(target.label, serverName));
    }

    const sortedRaws = [...validRaws].sort(([a], [b]) => {
      const aHas = hasNumericSuffix(a) ? 1 : 0;
      const bHas = hasNumericSuffix(b) ? 1 : 0;
      if (aHas !== bHas) return aHas - bHas;
      return a.localeCompare(b);
    });

    const entries: Record<string, McpJsonEntry> = Object.create(null);
    const rawNames: Record<string, string> = Object.create(null);
    for (const [serverName, rawEntry] of sortedRaws) {
      const base = buildResolvedBaseName(target.label, serverName);
      if (ctx.blocked?.has(base)) {
        ctx.log.warn(
          `[mcp-import] ${target.path}: skipping "${serverName}" — name is claimed by a user/builtin row`
        );
        continue;
      }

      let resolvedName: string;
      const exactExisting = existingByName.get(base);
      if (exactExisting && !usedExistingNames.has(base)) {
        resolvedName = base;
      } else if (!targetReserved.has(base)) {
        resolvedName = base;
      } else {
        const existing = findBestExistingMatch(
          serverName,
          target.label,
          existingByName,
          usedExistingNames,
          allServerNames
        );
        if (existing) {
          resolvedName = existing.name;
        } else {
          const reservedForName = new Set([...targetReserved, ...allBases]);
          reservedForName.delete(base);
          resolvedName = resolveWorkspaceMcpServerName({
            label: target.label,
            serverName,
            reserved: reservedForName,
          });
        }
      }

      const req = ctx.service.buildCreateRequest(resolvedName, rawEntry, target.path);
      if (!req) {
        ctx.log.warn(
          `[mcp-import] ${target.path}: skipping "${serverName}" — missing required fields`
        );
        continue;
      }
      usedExistingNames.add(resolvedName);
      targetReserved.add(resolvedName);
      ctx.reserved?.add(resolvedName);
      entries[resolvedName] = rawEntry;
      rawNames[resolvedName] = serverName;
    }

    declarations.push({ target, status: 'ok', entries, rawNames });
    results.push(result);
  }

  return { ...ctx, declarations, results };
}

function persistMcpSources(ctx: RefreshMcpImportsCtx): RefreshMcpImportsCtx {
  const results = ctx.results ? [...ctx.results] : [];

  for (let i = 0; i < (ctx.declarations ?? []).length; i += 1) {
    const decl = ctx.declarations![i];
    const result = results[i];

    if (decl.status === 'malformed') {
      continue;
    }

    const existingRows = ctx.db.appMcpServers.listBySourcePath(decl.target.path);
    const existingByName = new Map(existingRows.map((row) => [row.name, row]));
    const declaredNames = new Set<string>();

    if (decl.status === 'ok') {
      const allServerNames = new Set<string>(Object.values(decl.rawNames ?? {}));
      const protectedNames = new Set<string>(Object.keys(decl.entries ?? {}));
      let persistFailed = false;

      for (const [resolvedName, entry] of Object.entries(decl.entries ?? {}).sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        const rawName = decl.rawNames?.[resolvedName] ?? resolvedName;
        const req = ctx.service.buildCreateRequest(resolvedName, entry, decl.target.path);
        if (!req) {
          ctx.log.warn(
            `[mcp-import] ${decl.target.path}: skipping "${resolvedName}" — missing required fields`
          );
          continue;
        }
        declaredNames.add(resolvedName);

        let existing = existingByName.get(resolvedName);
        let legacy =
          rawName !== resolvedName
            ? findLegacyMatch(rawName, existingByName, allServerNames, protectedNames)
            : undefined;
        if (legacy && existing && legacy.id === existing.id) {
          legacy = undefined;
        }
        if (!existing) {
          existing = legacy;
          legacy = undefined;
        }

        if (!existing) {
          try {
            ctx.db.appMcpServers.create(req);
            result.added += 1;
          } catch (err) {
            ctx.log.warn(
              `[mcp-import] ${decl.target.path}: failed to create "${resolvedName}": ${err instanceof Error ? err.message : String(err)}`
            );
            persistFailed = true;
          }
          continue;
        }

        const shouldMergeEnabled = !!legacy && legacy.enabled && !existing.enabled;
        const needsName = existing.name !== resolvedName;
        if (needsName || !fieldsEqual(existing, req) || shouldMergeEnabled) {
          try {
            const updates: Omit<UpdateAppMcpServerRequest, 'id'> = {
              name: resolvedName,
              description: req.description,
              sourceType: req.sourceType,
              command: req.command,
              args: req.args,
              env: req.env,
              url: req.url,
              headers: req.headers,
            };
            if (shouldMergeEnabled) updates.enabled = true;
            ctx.db.appMcpServers.update(existing.id, updates);
            existing.name = resolvedName;
            existing.enabled = shouldMergeEnabled ? true : existing.enabled;
            existing.sourceType = req.sourceType;
            existing.command = req.command;
            existing.args = req.args;
            existing.env = req.env;
            existing.url = req.url;
            existing.headers = req.headers;
            result.updated += 1;
          } catch (err) {
            ctx.log.warn(
              `[mcp-import] ${decl.target.path}: failed to update "${resolvedName}": ${err instanceof Error ? err.message : String(err)}`
            );
            persistFailed = true;
          }
        }
      }

      if (persistFailed) {
        result.status = 'failed';
        result.error = 'one or more persistence operations failed';
      }

      if (result.status !== 'failed') {
        for (const row of existingRows) {
          if (!declaredNames.has(row.name)) {
            if (ctx.db.appMcpServers.delete(row.id)) {
              result.removed += 1;
            }
          }
        }
      }
    }
  }

  return { ...ctx, results };
}

function pruneMcpOrphans(ctx: RefreshMcpImportsCtx): RefreshMcpImportsCtx {
  if (ctx.skipOrphanPrune) {
    return {
      ...ctx,
      result: {
        results: ctx.results ?? [],
        orphanPruned: 0,
      },
    };
  }

  const targetPaths = new Set((ctx.targets ?? []).map((t) => t.path));
  let orphanPruned = 0;

  for (const row of ctx.db.appMcpServers.listImported()) {
    if (!row.sourcePath) continue;
    if (targetPaths.has(row.sourcePath)) continue;
    if (ctx.db.appMcpServers.delete(row.id)) {
      orphanPruned += 1;
    }
  }

  return {
    ...ctx,
    result: {
      results: ctx.results ?? [],
      orphanPruned,
    },
  };
}

const runRefreshMcpImports = (superpipe({})('refresh-mcp-imports') as PipelineAPI)
  .input(['ctx'])
  .pipe(buildMcpTargets, 'ctx', 'ctx')
  .pipe(loadMcpExistingNames, 'ctx', 'ctx')
  .pipe(extractMcpSources, 'ctx', 'ctx')
  .pipe(persistMcpSources, 'ctx', 'ctx')
  .pipe(pruneMcpOrphans, 'ctx', 'ctx')
  .end('ctx') as (ctx: RefreshMcpImportsCtx) => RefreshMcpImportsCtx;
