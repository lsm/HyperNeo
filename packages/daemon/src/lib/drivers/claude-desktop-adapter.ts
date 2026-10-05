import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type { FindQuery, PlaceGroup, WorkAdapter, WorkStatus, WorkSummary } from './types.ts';

const SESSIONS_PER_PLACE = 20;
const LIVE_TIMEOUT_MS = 5_000;

const RecordSchema = z.object({
  sessionId: z.string().startsWith('local_'),
  cliSessionId: z.string().optional(),
  originCwd: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().default(''),
  isArchived: z.boolean().default(false),
  lastActivityAt: z.number().default(0),
});

const LiveSessionsSchema = z.array(z.object({ sessionId: z.string(), status: z.string() }));

export type ClaudeDesktopRecord = z.infer<typeof RecordSchema>;
export type ClaudeLiveSession = z.infer<typeof LiveSessionsSchema>[number];

export interface ClaudeDesktopAdapterDeps {
  sessionsDir: string;
  machine: string;
  liveSessions: () => Promise<readonly ClaudeLiveSession[]>;
}

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

export type ClaudeRecordCache = Map<string, { modifiedAt: number; records: ClaudeDesktopRecord[] }>;

async function readRecord(path: string, cache: ClaudeRecordCache): Promise<ClaudeDesktopRecord[]> {
  try {
    const modifiedAt = (await stat(path)).mtimeMs;
    const cached = cache.get(path);
    if (cached?.modifiedAt === modifiedAt) return cached.records;
    const record = RecordSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    const records = record.success ? [record.data] : [];
    cache.set(path, { modifiedAt, records });
    return records;
  } catch {
    cache.delete(path);
    return [];
  }
}

export async function readClaudeDesktopRecords(
  sessionsDir: string,
  cache: ClaudeRecordCache
): Promise<ClaudeDesktopRecord[]> {
  const accounts = await listDir(sessionsDir);
  const scopes = (
    await Promise.all(
      accounts.map(async (account) =>
        (
          await listDir(join(sessionsDir, account))
        ).map((scope) => join(sessionsDir, account, scope))
      )
    )
  ).flat();
  const files = (
    await Promise.all(
      scopes.map(async (scope) =>
        (
          await listDir(scope)
        )
          .filter((name) => name.startsWith('local_') && name.endsWith('.json'))
          .map((name) => join(scope, name))
      )
    )
  ).flat();
  const present = new Set(files);
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
  return (await Promise.all(files.map((path) => readRecord(path, cache)))).flat();
}

export async function readLiveClaudeSessions(spawn: SpawnFn): Promise<ClaudeLiveSession[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = spawn(['claude', 'agents', '--json'], { stdout: 'pipe', stderr: 'ignore' });
    timer = setTimeout(() => proc.kill(), LIVE_TIMEOUT_MS);
    const [output] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const live = LiveSessionsSchema.safeParse(JSON.parse(output));
    return live.success ? live.data : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function claudeDesktopWorkStatus(
  record: ClaudeDesktopRecord,
  live: ReadonlyMap<string, string>
): WorkStatus {
  if (record.isArchived) return 'stopped';
  const status = record.cliSessionId ? live.get(record.cliSessionId) : undefined;
  if (status === 'busy') return 'running';
  return status === 'waiting' ? 'needs_you' : 'done';
}

function folderOf(record: ClaudeDesktopRecord): string | undefined {
  return record.originCwd ?? record.cwd;
}

export function buildClaudeDesktopGroups(
  records: readonly ClaudeDesktopRecord[],
  liveSessions: readonly ClaudeLiveSession[],
  query: FindQuery,
  deps: Pick<ClaudeDesktopAdapterDeps, 'machine'>
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  const live = new Map(liveSessions.map((session) => [session.sessionId, session.status]));
  const folders = [...new Set(records.flatMap((record) => folderOf(record) ?? []))];
  return folders
    .filter((folder) => !query.folder || folder === query.folder)
    .flatMap((folder) => {
      const name = basename(folder) || folder;
      const inFolder = records
        .filter((record) => folderOf(record) === folder)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const placeMatches = !text || `${name} ${folder}`.toLowerCase().includes(text);
      const place = { machine: deps.machine, folder, name };
      const work: WorkSummary[] = inFolder
        .filter((record) => query.includeClosed || !record.isArchived)
        .filter((record) => placeMatches || record.title.toLowerCase().includes(text ?? ''))
        .slice(0, SESSIONS_PER_PLACE)
        .map((record) => ({
          ref: { adapter: 'claude-desktop', id: record.sessionId },
          title: record.title,
          place,
          status: claudeDesktopWorkStatus(record, live),
          lastActivityAt: record.lastActivityAt,
          link: `claude://claude.ai/epitaxy/${record.sessionId}`,
        }));
      if (!placeMatches && work.length === 0) return [];
      return [
        {
          place,
          lastActivityAt: inFolder[0]?.lastActivityAt ?? 0,
          openCount: inFolder.filter((record) => !record.isArchived).length,
          archivedCount: inFolder.filter((record) => record.isArchived).length,
          adapters: ['claude-desktop'],
          work,
        },
      ];
    });
}

export function loadClaudeDesktopRecords(
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache
): Promise<ClaudeDesktopRecord[]> {
  return readClaudeDesktopRecords(deps.sessionsDir, cache);
}

export function loadLiveClaudeSessions(
  deps: ClaudeDesktopAdapterDeps
): Promise<readonly ClaudeLiveSession[]> {
  return deps.liveSessions();
}

const runClaudeDesktopFind = (superpipe({})('claude-desktop-find-work') as PipelineAPI)
  .input(['query', 'deps', 'cache'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(loadLiveClaudeSessions, 'deps', 'liveSessions')
  .pipe(buildClaudeDesktopGroups, ['records', 'liveSessions', 'query', 'deps'], 'groups')
  .endAsync('groups') as (
  query: FindQuery,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache
) => Promise<PlaceGroup[]>;

export function createClaudeDesktopAdapter(deps: ClaudeDesktopAdapterDeps): WorkAdapter {
  const cache: ClaudeRecordCache = new Map();
  return {
    id: 'claude-desktop',
    capabilities: ['find'],
    find: (query) => runClaudeDesktopFind(query, deps, cache),
  };
}
