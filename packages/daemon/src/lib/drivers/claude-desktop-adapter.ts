import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import type {
  FindQuery,
  PlaceGroup,
  Rejected,
  Result,
  WorkAdapter,
  WorkDetail,
  WorkRef,
  WorkStatus,
  WorkSummary,
} from './types.ts';
import { reject } from './work-operations.ts';

const SESSIONS_PER_PLACE = 20;
const LIVE_TIMEOUT_MS = 5_000;
const LIVE_REUSE_MS = 5_000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const REPLY_LIMIT = 4_000;

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
  projectsDir: string;
  machine: string;
  liveSessions: () => Promise<readonly ClaudeLiveSession[]>;
}

type Gate<Value> = { value: Value } | { reason: Rejected };

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
    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, LIVE_TIMEOUT_MS);
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

function toClaudeWork(
  record: ClaudeDesktopRecord,
  live: ReadonlyMap<string, string>,
  machine: string
): WorkSummary {
  const folder = folderOf(record);
  return {
    ref: { adapter: 'claude-desktop', id: record.sessionId },
    title: record.title,
    place: folder
      ? { machine, folder, name: basename(folder) || folder }
      : { machine, name: 'Chats' },
    status: claudeDesktopWorkStatus(record, live),
    lastActivityAt: record.lastActivityAt,
    link: `claude://claude.ai/epitaxy/${record.sessionId}`,
  };
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
        .map((record) => toClaudeWork(record, live, deps.machine));
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

export async function loadLiveClaudeSessions(
  deps: ClaudeDesktopAdapterDeps,
  records: readonly ClaudeDesktopRecord[]
): Promise<readonly ClaudeLiveSession[]> {
  return records.some((record) => !record.isArchived) ? deps.liveSessions() : [];
}

export function reuseLiveSessions(
  read: () => Promise<readonly ClaudeLiveSession[]>,
  now: () => number,
  freshForMs = LIVE_REUSE_MS
): () => Promise<readonly ClaudeLiveSession[]> {
  let cached: { at: number; sessions: Promise<readonly ClaudeLiveSession[]> } | null = null;
  return () => {
    if (!cached || now() - cached.at >= freshForMs) cached = { at: now(), sessions: read() };
    return cached.sessions;
  };
}

const runClaudeDesktopFind = (superpipe({})('claude-desktop-find-work') as PipelineAPI)
  .input(['query', 'deps', 'cache'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(loadLiveClaudeSessions, ['deps', 'records'], 'liveSessions')
  .pipe(buildClaudeDesktopGroups, ['records', 'liveSessions', 'query', 'deps'], 'groups')
  .endAsync('groups') as (
  query: FindQuery,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache
) => Promise<PlaceGroup[]>;

export function claudeTranscriptPath(
  projectsDir: string,
  record: ClaudeDesktopRecord
): string | null {
  const cwd = record.cwd ?? record.originCwd;
  if (!cwd || !record.cliSessionId) return null;
  return join(projectsDir, cwd.replace(/[/.]/g, '-'), `${record.cliSessionId}.jsonl`);
}

async function readTailLines(path: string, bytes: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

function assistantText(line: string): string | null {
  try {
    const entry = JSON.parse(line) as { type?: unknown; message?: { content?: unknown } };
    if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) return null;
    const texts = entry.message.content.flatMap((part: { type?: unknown; text?: unknown }) =>
      part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    );
    return texts.at(-1)?.trim() || null;
  } catch {
    return null;
  }
}

export function lastClaudeReply(lines: readonly string[]): string | null {
  for (const line of [...lines].reverse()) {
    const text = assistantText(line);
    if (text) return text;
  }
  return null;
}

export function requireClaudeRecord(
  ref: WorkRef,
  records: readonly ClaudeDesktopRecord[]
): Gate<ClaudeDesktopRecord> {
  const record = records.find((candidate) => candidate.sessionId === ref.id);
  return record
    ? { value: record }
    : { reason: reject('not_found', `No Claude Code Desktop session ${ref.id}.`) };
}

export async function readClaudeReply(
  record: ClaudeDesktopRecord,
  deps: ClaudeDesktopAdapterDeps
): Promise<string | null> {
  const path = claudeTranscriptPath(deps.projectsDir, record);
  if (!path) return null;
  try {
    return lastClaudeReply(await readTailLines(path, TRANSCRIPT_TAIL_BYTES));
  } catch {
    return null;
  }
}

export function describeClaudeSession(
  record: ClaudeDesktopRecord,
  liveSessions: readonly ClaudeLiveSession[],
  reply: string | null,
  deps: ClaudeDesktopAdapterDeps
): Result<WorkDetail> {
  const live = new Map(liveSessions.map((session) => [session.sessionId, session.status]));
  const work = toClaudeWork(record, live, deps.machine);
  return { ok: true, value: reply ? { ...work, lastReply: reply.slice(0, REPLY_LIMIT) } : work };
}

const runClaudeDesktopStatus = (superpipe({})('claude-desktop-work-status') as PipelineAPI)
  .input(['ref', 'deps', 'cache'])
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(requireClaudeRecord, ['ref', 'records'], 'result:outcome')
  .pipe(loadLiveClaudeSessions, ['deps', 'records'], 'liveSessions')
  .pipe(readClaudeReply, ['outcome', 'deps'], 'reply')
  .pipe(describeClaudeSession, ['outcome', 'liveSessions', 'reply', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache
) => Promise<Result<WorkDetail>>;

export function createClaudeDesktopAdapter(deps: ClaudeDesktopAdapterDeps): WorkAdapter {
  const cache: ClaudeRecordCache = new Map();
  const reused = { ...deps, liveSessions: reuseLiveSessions(deps.liveSessions, Date.now) };
  return {
    id: 'claude-desktop',
    capabilities: ['find', 'status'],
    find: (query) => runClaudeDesktopFind(query, reused, cache),
    status: (ref) => runClaudeDesktopStatus(ref, reused, cache),
  };
}
