import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import { withChatEvidence } from './places.ts';
import type {
  FindQuery,
  PlaceGroup,
  Rejected,
  Result,
  StartRequest,
  WorkAdapter,
  WorkDetail,
  WorkRef,
  WorkStatus,
  WorkSummary,
} from './types.ts';
import { ensureStartFolder } from './start-folder.ts';
import { reject } from './work-operations.ts';

const SESSIONS_PER_PLACE = 20;
const LIVE_TIMEOUT_MS = 5_000;
const LIVE_REUSE_MS = 5_000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const REPLY_LIMIT = 4_000;
const RELAY_TIMEOUT_MS = 120_000;
const RESUME_SETTLE_MS = 3_000;
const OPEN_WAIT_MS = 60_000;
const OPEN_POLL_MS = 2_000;
const OPENING_MESSAGE =
  'HyperNeo is handing you a task; it arrives in the next message. Reply only: ready.';

const RecordSchema = z.object({
  sessionId: z.string().startsWith('local_'),
  cliSessionId: z.string().optional(),
  originCwd: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().default(''),
  isArchived: z.boolean().default(false),
  lastActivityAt: z.number().default(0),
});

const LiveSessionsSchema = z.array(
  z.object({ sessionId: z.string(), status: z.string(), name: z.string().optional() })
);

export type ClaudeDesktopRecord = z.infer<typeof RecordSchema>;
export type ClaudeLiveSession = z.infer<typeof LiveSessionsSchema>[number];

export interface ClaudeDesktopAdapterDeps {
  sessionsDir: string;
  projectsDir: string;
  machine: string;
  liveSessions: () => Promise<readonly ClaudeLiveSession[]>;
  spawn: SpawnFn;
  folderExists: (folder: string) => boolean;
  makeFolder: (folder: string) => void;
  homeDir: string;
  gitRoot: (folder: string) => Promise<string | null>;
  newId: () => string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  searchChats?: (text: string) => Promise<readonly WorkChatMatch[]>;
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
    if (!live.success) throw new Error('claude agents --json answered in an unknown shape.');
    return live.data;
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

export function matchClaudeSessions(
  chats: readonly WorkChatMatch[]
): ReadonlyMap<string, WorkChatMatch> {
  return new Map(
    chats.flatMap((chat) =>
      chat.kind === 'claude' && chat.sessionId ? [[chat.sessionId, chat] as const] : []
    )
  );
}

export function buildClaudeDesktopGroups(
  records: readonly ClaudeDesktopRecord[],
  liveSessions: readonly ClaudeLiveSession[],
  query: FindQuery,
  deps: Pick<ClaudeDesktopAdapterDeps, 'machine'>,
  matched: ReadonlyMap<string, WorkChatMatch> = new Map()
): PlaceGroup[] {
  const hit = (record: ClaudeDesktopRecord) =>
    record.cliSessionId ? matched.get(record.cliSessionId) : undefined;
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
        .filter(
          (record) =>
            placeMatches || !!hit(record) || record.title.toLowerCase().includes(text ?? '')
        )
        .map((record) => withChatEvidence(toClaudeWork(record, live, deps.machine), hit(record)))
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .slice(0, SESSIONS_PER_PLACE);
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
  if (!records.some((record) => !record.isArchived)) return [];
  return deps.liveSessions().catch((): readonly ClaudeLiveSession[] => []);
}

export async function probeLiveClaudeSessions(
  deps: ClaudeDesktopAdapterDeps
): Promise<Gate<readonly ClaudeLiveSession[]>> {
  try {
    return { value: await deps.liveSessions() };
  } catch (error) {
    return {
      reason: reject(
        'not_delivered',
        `Could not tell whether Claude Code Desktop runs this session: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
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
  .input(['query', 'deps', 'cache', 'chats'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(loadLiveClaudeSessions, ['deps', 'records'], 'liveSessions')
  .pipe(matchClaudeSessions, 'chats', 'matched')
  .pipe(buildClaudeDesktopGroups, ['records', 'liveSessions', 'query', 'deps', 'matched'], 'groups')
  .endAsync('groups') as (
  query: FindQuery,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache,
  chats: readonly WorkChatMatch[]
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

export function requireOpenClaudeRecord(
  record: ClaudeDesktopRecord
): Gate<ClaudeDesktopRecord & { cliSessionId: string }> {
  if (record.isArchived) return { reason: reject('not_open', `${record.title} is archived.`) };
  const { cliSessionId } = record;
  return cliSessionId
    ? { value: { ...record, cliSessionId } }
    : { reason: reject('not_open', `${record.title} has no Claude Code session yet.`) };
}

const RELAY_REPLY_NOTE =
  '(Relayed from HyperNeo by a one-shot sender that has already exited. Answer here in this session; HyperNeo reads your reply from this chat. Do not message the sender back.)';

export function claudeRelayPrompt(name: string, message: string): string {
  return `Use the SendMessage tool once to send the text between the message tags, exactly and without the tags, to the session named ${JSON.stringify(name)}. Do nothing else, then stop.\n<message>\n${message}\n\n${RELAY_REPLY_NOTE}\n</message>`;
}

export function transcriptHasRelayedMessage(lines: readonly string[], message: string): boolean {
  const opening = JSON.stringify(message.trim().split('\n')[0].slice(0, 200)).slice(1, -1);
  return lines.some((line) => line.includes('cross-session-message') && line.includes(opening));
}

async function transcriptSize(path: string | null): Promise<number> {
  if (!path) return 0;
  return stat(path).then(
    (info) => info.size,
    () => 0
  );
}

async function readLinesAfter(path: string, offset: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.min(offset, size);
    const buffer = Buffer.alloc(Math.min(size - start, TRANSCRIPT_TAIL_BYTES));
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8').split('\n');
  } finally {
    await handle.close();
  }
}

async function relayToLiveSession(
  record: ClaudeDesktopRecord,
  name: string,
  message: string,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<{ delivered: boolean }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const path = claudeTranscriptPath(deps.projectsDir, record);
  const before = await transcriptSize(path);
  try {
    const proc = deps.spawn(
      [
        'claude',
        '-p',
        '--model',
        'haiku',
        '--max-turns',
        '4',
        '--allowedTools',
        'SendMessage ListAgents',
        '-n',
        'HyperNeo relay',
        claudeRelayPrompt(name, message),
      ],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    timer = setTimeout(() => proc.kill('SIGKILL'), RELAY_TIMEOUT_MS);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0)
      return reject('not_delivered', stderr.trim() || `The relay exited with ${code}.`);
    const appended = path ? await readLinesAfter(path, before).catch(() => []) : [];
    return { ok: true, value: { delivered: transcriptHasRelayedMessage(appended, message) } };
  } catch (error) {
    return reject('not_delivered', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

export async function sendClaudeMessage(
  record: ClaudeDesktopRecord & { cliSessionId: string },
  liveSessions: readonly ClaudeLiveSession[],
  message: string,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<{ delivered: boolean }>> {
  const live = liveSessions.find((session) => session.sessionId === record.cliSessionId);
  if (live) {
    const name = live.name;
    if (!name || liveSessions.filter((session) => session.name === name).length > 1) {
      return reject('not_delivered', `${record.title} has no unique name to relay a message to.`);
    }
    return relayToLiveSession(record, name, message, deps);
  }
  return resumeClaudeSession(record, message, deps);
}

export async function resumeClaudeSession(
  record: ClaudeDesktopRecord & { cliSessionId: string },
  message: string,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<{ delivered: boolean }>> {
  const folder = record.cwd ?? record.originCwd;
  if (!folder || !deps.folderExists(folder)) {
    return reject(
      'not_delivered',
      `${record.title} works in ${folder ?? 'no folder'}, which is gone.`
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = deps.spawn(['claude', '-p', '--resume', record.cliSessionId, '--', message], {
      cwd: folder,
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });
    const stderr = new Response(proc.stderr).text().catch(() => '');
    const early = await Promise.race([
      proc.exited.catch(() => -1),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RESUME_SETTLE_MS);
      }),
    ]);
    if (early === null) return { ok: true, value: { delivered: false } };
    if (early === 0) return { ok: true, value: { delivered: true } };
    return reject(
      'not_delivered',
      (await stderr).trim() || `claude --resume exited with ${early}.`
    );
  } catch (error) {
    return reject('not_delivered', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

const runClaudeDesktopSend = (superpipe({})('claude-desktop-send-work') as PipelineAPI)
  .input(['ref', 'message', 'deps', 'cache'])
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(requireClaudeRecord, ['ref', 'records'], 'result:outcome')
  .pipe(requireOpenClaudeRecord, 'outcome', 'result:outcome')
  .pipe((record: ClaudeDesktopRecord) => record, 'outcome', 'record')
  .pipe(probeLiveClaudeSessions, 'deps', 'result:outcome')
  .pipe((live: readonly ClaudeLiveSession[]) => live, 'outcome', 'liveSessions')
  .pipe(sendClaudeMessage, ['record', 'liveSessions', 'message', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache
) => Promise<Result<{ delivered: boolean }>>;

export function selectClaudeStartFolder(
  request: StartRequest,
  deps: ClaudeDesktopAdapterDeps
): Gate<string> {
  const { place } = request;
  if (place.spaceId) {
    return { reason: reject('invalid_place', 'Spaces take work through the space adapter.') };
  }
  if (place.machine !== deps.machine) {
    return { reason: reject('invalid_place', `${place.name} is on ${place.machine}, not here.`) };
  }
  if (!place.folder) {
    return { reason: reject('invalid_place', 'A Claude Code session needs a folder to work in.') };
  }
  return ensureStartFolder(place.folder, request.createFolder, deps);
}

async function runToExit(
  deps: ClaudeDesktopAdapterDeps,
  args: string[],
  cwd: string
): Promise<{ code: number; stderr: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = deps.spawn(args, { cwd, stdout: 'ignore', stderr: 'pipe' });
    timer = setTimeout(() => proc.kill('SIGKILL'), RELAY_TIMEOUT_MS);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilLive(
  cliSessionId: string,
  deps: ClaudeDesktopAdapterDeps
): Promise<readonly ClaudeLiveSession[] | null> {
  const until = deps.now() + OPEN_WAIT_MS;
  while (deps.now() < until) {
    const live = await deps.liveSessions().catch((): readonly ClaudeLiveSession[] => []);
    if (live.some((candidate) => candidate.sessionId === cliSessionId && candidate.name)) {
      return live;
    }
    await deps.sleep(OPEN_POLL_MS);
  }
  return null;
}

export async function startClaudeSession(
  folder: string,
  request: StartRequest,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<WorkSummary>> {
  const cliSessionId = deps.newId();
  const sessionId = `local_${cliSessionId}`;
  const repo = await deps.gitRoot(folder).catch(() => null);
  const worktree = repo ? `neo-${cliSessionId.slice(0, 8)}` : null;
  const cwd = repo && worktree ? join(repo, '.claude', 'worktrees', worktree) : folder;
  try {
    const opened = await runToExit(
      deps,
      [
        'claude',
        '-p',
        '--session-id',
        cliSessionId,
        '-n',
        request.title,
        ...(worktree ? ['--worktree', worktree] : []),
        '--',
        OPENING_MESSAGE,
      ],
      folder
    );
    if (opened.code !== 0) {
      return reject('not_delivered', opened.stderr || `claude -p exited with ${opened.code}.`);
    }
    deps
      .spawn(['script', '-q', '/dev/null', 'claude', '--desktop', '--resume', cliSessionId], {
        cwd,
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      })
      .exited.catch(() => undefined);
  } catch (error) {
    return reject('not_delivered', error instanceof Error ? error.message : String(error));
  }
  const live = await waitUntilLive(cliSessionId, deps);
  const session = live?.find((candidate) => candidate.sessionId === cliSessionId);
  if (!live || !session) {
    return reject(
      'not_delivered',
      `${sessionId} was created but Claude Code Desktop did not open it; send the task to it with work.send.`
    );
  }
  const record: ClaudeDesktopRecord = {
    sessionId,
    cliSessionId,
    cwd,
    title: request.title,
    isArchived: false,
    lastActivityAt: deps.now(),
  };
  const sent = await sendClaudeMessage({ ...record, cliSessionId }, live, request.message, deps);
  if (!sent.ok) {
    return reject(
      'not_delivered',
      `${sessionId} opened, but the task did not reach it: ${sent.detail}`
    );
  }
  return {
    ok: true,
    value: {
      ...toClaudeWork(record, new Map([[cliSessionId, session.status]]), deps.machine),
      place: { machine: deps.machine, folder, name: request.place.name },
      status: sent.value.delivered ? 'running' : 'queued',
    },
  };
}

const runClaudeDesktopStart = (superpipe({})('claude-desktop-start-work') as PipelineAPI)
  .input(['request', 'deps'])
  .pipe(selectClaudeStartFolder, ['request', 'deps'], 'result:outcome')
  .pipe(startClaudeSession, ['outcome', 'request', 'deps'], 'outcome')
  .endAsync('outcome') as (
  request: StartRequest,
  deps: ClaudeDesktopAdapterDeps
) => Promise<Result<WorkSummary>>;

export function createClaudeDesktopAdapter(deps: ClaudeDesktopAdapterDeps): WorkAdapter {
  const cache: ClaudeRecordCache = new Map();
  const reused = { ...deps, liveSessions: reuseLiveSessions(deps.liveSessions, Date.now) };
  return {
    id: 'claude-desktop',
    capabilities: ['find', 'start', 'send', 'status'],
    find: async (query) =>
      runClaudeDesktopFind(
        query,
        reused,
        cache,
        query.text && !query.spaceId && deps.searchChats ? await deps.searchChats(query.text) : []
      ),
    start: (request) => runClaudeDesktopStart(request, deps),
    send: (ref, message) => runClaudeDesktopSend(ref, message, deps, cache),
    status: (ref) => runClaudeDesktopStatus(ref, reused, cache),
  };
}
