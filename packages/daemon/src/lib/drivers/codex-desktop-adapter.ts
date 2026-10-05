import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Database } from '../../storage/sqlite-compat.ts';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import type { CodexAppServer } from './codex-app-server.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
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
import { reject } from './work-operations.ts';

const OWN_THREADS = `cwd IS NOT NULL AND COALESCE(source, '') NOT LIKE '%subagent%'`;
const THREAD_COLUMNS = `id, COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(substr(first_user_message, 1, 80), ''), 'Untitled thread') AS title,
  cwd AS folder, COALESCE(archived, 0) AS archived, COALESCE(updated_at_ms, 0) AS updatedAt`;
const THREADS_PER_PLACE = 20;
const CLOSED_THREADS = 500;
const RECENT_MS = 2 * 60_000;
const BUSY_TIMEOUT_MS = 2_000;
const ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024;
const REPLY_LIMIT = 4_000;
const QUEUE_TIMEOUT_MS = 30_000;
const TURN_MARKERS = new Set(['task_started', 'task_complete', 'turn_aborted']);

export interface CodexRootRow {
  name: string;
  folder: string;
  lastActiveAt: number;
}

export interface CodexFolderRow {
  folder: string;
  openCount: number;
  archivedCount: number;
  lastActiveAt: number;
}

export interface CodexThreadRow {
  id: string;
  title: string;
  folder: string;
  archived: number;
  updatedAt: number;
}

export interface CodexSnapshot {
  roots: CodexRootRow[];
  folders: CodexFolderRow[];
  threads: CodexThreadRow[];
}

export interface CodexDesktopAdapterDeps {
  statePath: string;
  worktreesDir: string;
  machine: string;
  now: () => number;
  spawn: SpawnFn;
  appServer: () => Promise<CodexAppServer>;
  folderExists: (folder: string) => boolean;
}

export interface CodexThreadDetail {
  thread: CodexThreadRow & { rolloutPath: string };
  roots: CodexRootRow[];
}

export interface CodexTurnState {
  marker: string | null;
  reply: string | null;
}

type Gate<Value> = { value: Value } | { reason: Rejected };

interface CodexPlace extends CodexFolderRow {
  name: string;
  known: boolean;
}

export function readCodexSnapshot(statePath: string, includeClosed: boolean): CodexSnapshot {
  const db = new Database(statePath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return {
      roots: db
        .prepare(
          `SELECT COALESCE(p.name, '') AS name, r.path AS folder,
             COALESCE(p.updated_at_ms, 0) AS lastActiveAt
             FROM projects p JOIN project_roots r ON r.project_id = p.id WHERE r.path IS NOT NULL`
        )
        .all() as CodexRootRow[],
      folders: db
        .prepare(
          `SELECT cwd AS folder, SUM(COALESCE(archived, 0) = 0) AS openCount,
             SUM(COALESCE(archived, 0) != 0) AS archivedCount,
             COALESCE(MAX(updated_at_ms), 0) AS lastActiveAt FROM threads WHERE ${OWN_THREADS} GROUP BY cwd`
        )
        .all() as CodexFolderRow[],
      threads: db
        .prepare(
          `SELECT * FROM (
             SELECT ${THREAD_COLUMNS} FROM threads WHERE ${OWN_THREADS} AND COALESCE(archived, 0) = 0
             UNION ALL
             SELECT * FROM (SELECT ${THREAD_COLUMNS} FROM threads
               WHERE ${OWN_THREADS} AND ? = 1 AND COALESCE(archived, 0) != 0
               ORDER BY updatedAt DESC LIMIT ${CLOSED_THREADS}))
           ORDER BY updatedAt DESC`
        )
        .all(includeClosed ? 1 : 0) as CodexThreadRow[],
    };
  } finally {
    db.close();
  }
}

export function codexProjectFolder(
  folder: string,
  roots: readonly CodexRootRow[],
  worktreesDir: string
): string {
  if (!folder.startsWith(`${worktreesDir}/`)) return folder;
  const matches = roots.filter((root) => basename(root.folder) === basename(folder));
  return matches.length === 1 ? matches[0].folder : folder;
}

function codexPlaces(snapshot: CodexSnapshot, worktreesDir: string): CodexPlace[] {
  const places = new Map<string, CodexPlace>();
  for (const root of snapshot.roots) {
    places.set(root.folder, {
      ...root,
      name: root.name || basename(root.folder) || root.folder,
      openCount: 0,
      archivedCount: 0,
      known: true,
    });
  }
  for (const row of snapshot.folders) {
    const folder = codexProjectFolder(row.folder, snapshot.roots, worktreesDir);
    const place = places.get(folder) ?? {
      folder,
      name: basename(folder) || folder,
      openCount: 0,
      archivedCount: 0,
      lastActiveAt: 0,
      known: false,
    };
    places.set(folder, {
      ...place,
      openCount: place.openCount + row.openCount,
      archivedCount: place.archivedCount + row.archivedCount,
      lastActiveAt: Math.max(place.lastActiveAt, row.lastActiveAt),
    });
  }
  return [...places.values()];
}

function codexStatus(thread: CodexThreadRow, now: number): WorkStatus {
  if (thread.archived) return 'stopped';
  return now - thread.updatedAt < RECENT_MS ? 'running' : 'done';
}

export function buildCodexGroups(
  snapshot: CodexSnapshot,
  query: FindQuery,
  deps: Omit<CodexDesktopAdapterDeps, 'statePath'>
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  const now = deps.now();
  return codexPlaces(snapshot, deps.worktreesDir)
    .filter((place) => !query.folder || place.folder === query.folder)
    .filter((place) => query.includeClosed || place.openCount > 0 || place.known)
    .flatMap((place) => {
      const placeMatches = !text || `${place.name} ${place.folder}`.toLowerCase().includes(text);
      const where = { machine: deps.machine, folder: place.folder, name: place.name };
      const work: WorkSummary[] = snapshot.threads
        .filter(
          (thread) =>
            codexProjectFolder(thread.folder, snapshot.roots, deps.worktreesDir) === place.folder
        )
        .filter((thread) => placeMatches || thread.title.toLowerCase().includes(text ?? ''))
        .slice(0, THREADS_PER_PLACE)
        .map((thread) => ({
          ref: { adapter: 'codex-desktop', id: thread.id },
          title: thread.title,
          place: where,
          status: codexStatus(thread, now),
          lastActivityAt: thread.updatedAt,
          link: `codex://threads/${thread.id}`,
        }));
      if (!placeMatches && work.length === 0) return [];
      return [
        {
          place: where,
          lastActivityAt: place.lastActiveAt,
          openCount: place.openCount,
          archivedCount: place.archivedCount,
          adapters: ['codex-desktop'],
          work,
        },
      ];
    });
}

export function loadCodexSnapshot(query: FindQuery, deps: CodexDesktopAdapterDeps): CodexSnapshot {
  return readCodexSnapshot(deps.statePath, query.includeClosed);
}

const runCodexFind = (superpipe({})('codex-find-work') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadCodexSnapshot, ['query', 'deps'], 'snapshot')
  .pipe(buildCodexGroups, ['snapshot', 'query', 'deps'], 'groups')
  .end('groups') as (query: FindQuery, deps: CodexDesktopAdapterDeps) => PlaceGroup[];

export function readCodexThread(statePath: string, id: string): CodexThreadDetail | null {
  const db = new Database(statePath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const thread = db
      .prepare(
        `SELECT ${THREAD_COLUMNS}, rollout_path AS rolloutPath FROM threads
          WHERE id = ? AND ${OWN_THREADS}`
      )
      .get(id) as CodexThreadDetail['thread'] | null | undefined;
    if (!thread) return null;
    const roots = db
      .prepare(
        `SELECT COALESCE(p.name, '') AS name, r.path AS folder, 0 AS lastActiveAt
           FROM projects p JOIN project_roots r ON r.project_id = p.id WHERE r.path IS NOT NULL`
      )
      .all() as CodexRootRow[];
    return { thread, roots };
  } finally {
    db.close();
  }
}

export async function readRolloutTail(path: string, bytes = ROLLOUT_TAIL_BYTES): Promise<string[]> {
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

function parseLine(line: string): { type?: unknown; payload?: Record<string, unknown> } | null {
  try {
    const entry = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> };
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

function messageText(payload: Record<string, unknown>, role: string): string | null {
  if (payload.type !== 'message' || payload.role !== role) return null;
  const parts = Array.isArray(payload.content) ? payload.content : [];
  const text = parts
    .flatMap((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : []
    )
    .join('\n')
    .trim();
  return text || null;
}

export function codexTurnState(lines: readonly string[]): CodexTurnState {
  let reply: string | null = null;
  for (const line of [...lines].reverse()) {
    const entry = parseLine(line);
    const payload = entry?.payload ?? {};
    if (reply === null && entry?.type === 'response_item')
      reply = messageText(payload, 'assistant');
    if (entry?.type === 'event_msg' && TURN_MARKERS.has(String(payload.type))) {
      const finalMessage =
        payload.type === 'task_complete' && typeof payload.last_agent_message === 'string'
          ? payload.last_agent_message
          : null;
      return { marker: String(payload.type), reply: finalMessage ?? reply };
    }
  }
  return { marker: null, reply };
}

function turnStatus(thread: CodexThreadRow, state: CodexTurnState, now: number): WorkStatus {
  if (thread.archived) return 'stopped';
  if (state.marker === 'task_started') return 'running';
  if (state.marker === 'turn_aborted') return 'stopped';
  return state.marker === 'task_complete' ? 'done' : codexStatus(thread, now);
}

export function requireCodexThread(
  ref: WorkRef,
  deps: CodexDesktopAdapterDeps
): Gate<CodexThreadDetail> {
  const detail = readCodexThread(deps.statePath, ref.id);
  return detail ? { value: detail } : { reason: reject('not_found', `No Codex thread ${ref.id}.`) };
}

export function requireOpenCodexThread(detail: CodexThreadDetail): Gate<CodexThreadDetail> {
  return detail.thread.archived
    ? { reason: reject('not_open', `Codex thread ${detail.thread.id} is archived.`) }
    : { value: detail };
}

export async function readCodexTurn(detail: CodexThreadDetail): Promise<CodexTurnState> {
  try {
    return codexTurnState(await readRolloutTail(detail.thread.rolloutPath));
  } catch {
    return { marker: null, reply: null };
  }
}

export function describeCodexThread(
  detail: CodexThreadDetail,
  state: CodexTurnState,
  deps: CodexDesktopAdapterDeps
): Result<WorkDetail> {
  const { thread, roots } = detail;
  const folder = codexProjectFolder(thread.folder, roots, deps.worktreesDir);
  const root = roots.find((candidate) => candidate.folder === folder);
  return {
    ok: true,
    value: {
      ref: { adapter: 'codex-desktop', id: thread.id },
      title: thread.title,
      place: { machine: deps.machine, folder, name: root?.name || basename(folder) || folder },
      status: turnStatus(thread, state, deps.now()),
      lastActivityAt: thread.updatedAt,
      link: `codex://threads/${thread.id}`,
      ...(state.reply ? { lastReply: state.reply.slice(0, REPLY_LIMIT) } : {}),
    },
  };
}

export function rolloutHasUserMessage(lines: readonly string[], message: string): boolean {
  const opening = message.trim().split('\n')[0].slice(0, 200);
  return lines.some((line) => {
    const entry = parseLine(line);
    if (entry?.type !== 'response_item') return false;
    return messageText(entry.payload ?? {}, 'user')?.includes(opening) ?? false;
  });
}

export async function queueCodexMessage(
  detail: CodexThreadDetail,
  message: string,
  deps: CodexDesktopAdapterDeps
): Promise<Result<{ delivered: boolean }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = deps.spawn(
      ['codex', 'queue', `--thread=${detail.thread.id}`, `--message=${message}`],
      { stdout: 'ignore', stderr: 'pipe' }
    );
    timer = setTimeout(() => proc.kill(), QUEUE_TIMEOUT_MS);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      return reject('not_delivered', stderr.trim() || `codex queue exited with ${code}.`);
    }
    const tail = await readRolloutTail(detail.thread.rolloutPath).catch(() => []);
    return { ok: true, value: { delivered: rolloutHasUserMessage(tail, message) } };
  } catch (error) {
    return reject('not_delivered', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

const runCodexStatus = (superpipe({})('codex-work-status') as PipelineAPI)
  .input(['ref', 'deps'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe(readCodexTurn, 'outcome', 'turn')
  .pipe(describeCodexThread, ['outcome', 'turn', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  deps: CodexDesktopAdapterDeps
) => Promise<Result<WorkDetail>>;

const runCodexSend = (superpipe({})('codex-send-work') as PipelineAPI)
  .input(['ref', 'message', 'deps'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe(requireOpenCodexThread, 'outcome', 'result:outcome')
  .pipe(queueCodexMessage, ['outcome', 'message', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  deps: CodexDesktopAdapterDeps
) => Promise<Result<{ delivered: boolean }>>;

export function selectCodexStartFolder(
  request: StartRequest,
  deps: CodexDesktopAdapterDeps
): Gate<string> {
  const { place } = request;
  if (place.spaceId) {
    return { reason: reject('invalid_place', 'Spaces take work through the space adapter.') };
  }
  if (place.machine !== deps.machine) {
    return { reason: reject('invalid_place', `${place.name} is on ${place.machine}, not here.`) };
  }
  if (!place.folder) {
    return { reason: reject('invalid_place', 'A Codex thread needs a folder to work in.') };
  }
  return deps.folderExists(place.folder)
    ? { value: place.folder }
    : { reason: reject('invalid_place', `${place.folder} does not exist.`) };
}

export function startedThreadId(started: unknown): string | null {
  const value = started as { thread?: { id?: unknown }; threadId?: unknown } | null;
  const id = value?.thread?.id ?? value?.threadId;
  return typeof id === 'string' && id ? id : null;
}

export async function startCodexThread(
  folder: string,
  request: StartRequest,
  deps: CodexDesktopAdapterDeps
): Promise<Result<WorkSummary>> {
  let server: CodexAppServer;
  try {
    server = await deps.appServer();
  } catch (error) {
    return reject(
      'unreachable',
      `The Codex app-server is not running: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let threadId: string | null = null;
  try {
    threadId = startedThreadId(await server.call('thread/start', { cwd: folder }));
    if (!threadId) return reject('not_delivered', 'thread/start returned no thread id.');
    await server.call('thread/name/set', { threadId, name: request.title });
    await server.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: request.message }],
    });
    return {
      ok: true,
      value: {
        ref: { adapter: 'codex-desktop', id: threadId },
        title: request.title,
        place: { machine: deps.machine, folder, name: request.place.name },
        status: 'running',
        lastActivityAt: deps.now(),
        link: `codex://threads/${threadId}`,
      },
    };
  } catch (error) {
    const made = threadId ? ` Thread ${threadId} was created without its first turn.` : '';
    return reject(
      'not_delivered',
      `${error instanceof Error ? error.message : String(error)}${made}`
    );
  } finally {
    server.close();
  }
}

const runCodexStart = (superpipe({})('codex-start-work') as PipelineAPI)
  .input(['request', 'deps'])
  .pipe(selectCodexStartFolder, ['request', 'deps'], 'result:outcome')
  .pipe(startCodexThread, ['outcome', 'request', 'deps'], 'outcome')
  .endAsync('outcome') as (
  request: StartRequest,
  deps: CodexDesktopAdapterDeps
) => Promise<Result<WorkSummary>>;

export function createCodexDesktopAdapter(deps: CodexDesktopAdapterDeps): WorkAdapter {
  return {
    id: 'codex-desktop',
    capabilities: ['find', 'start', 'send', 'status'],
    find: (query) => runCodexFind(query, deps),
    start: (request) => runCodexStart(request, deps),
    send: (ref, message) => runCodexSend(ref, message, deps),
    status: (ref) => runCodexStatus(ref, deps),
  };
}
