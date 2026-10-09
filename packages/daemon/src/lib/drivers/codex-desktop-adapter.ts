import { basename, join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Database } from '../../storage/sqlite-compat.ts';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import type { CodexAppServer } from './codex-app-server.ts';
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
  WorkExchangeEntry,
  WorkInput,
  WorkRef,
  WorkStatus,
  WorkSummary,
} from './types.ts';
import { selectLocalStartFolder } from './start-folder.ts';
import { reject } from './work-operations.ts';
import {
  boundExchange,
  exchangeEntry,
  recentWorkInputs,
  type WorkExchange,
  withExchange,
  workEntryTime,
  workInput,
} from './work-messages.ts';
import { readTailLines } from './transcript-tail.ts';

const OWN_THREADS = `cwd IS NOT NULL AND COALESCE(source, '') NOT LIKE '%subagent%'`;
const THREAD_TITLE = `substr(COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(first_user_message, '')), 1, 200)`;
const THREAD_COLUMNS = `id, COALESCE(NULLIF(substr(trim(replace(replace(${THREAD_TITLE}, char(13), ' '), char(10), ' ')), 1, 80), ''), 'Untitled thread') AS title,
  cwd AS folder, COALESCE(archived, 0) AS archived, COALESCE(updated_at_ms, 0) AS updatedAt`;
const THREADS_PER_PLACE = 20;
const CLOSED_THREADS = 500;
const RECENT_MS = 2 * 60_000;
const BUSY_TIMEOUT_MS = 2_000;
const ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024;
const REPLY_LIMIT = 4_000;
const QUEUE_TIMEOUT_MS = 30_000;
const TURN_MARKERS = new Set(['task_started', 'task_complete', 'turn_aborted']);
const INJECTED_INPUT = /^<([a-z_]+)>[\s\S]*<\/\1>$/;

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
  makeFolder: (folder: string) => void;
  homeDir: string;
  gitRoot: (folder: string) => Promise<string | null>;
  newId: () => string;
  searchChats?: (text: string) => Promise<readonly WorkChatMatch[]>;
}

export interface CodexThreadDetail {
  thread: CodexThreadRow & { rolloutPath: string };
  roots: CodexRootRow[];
}

export interface CodexTurnState {
  marker: string | null;
  reply: string | null;
  replyAt?: number;
  inputs?: WorkInput[];
  exchange?: WorkExchange;
}

type Gate<Value> = { value: Value } | { reason: Rejected };

interface CodexPlace extends CodexFolderRow {
  name: string;
  known: boolean;
}

function readCodexStateOnce<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return read(db);
  } finally {
    db.close();
  }
}

export function withCodexState<T>(statePath: string, read: (db: Database) => T): T {
  try {
    return readCodexStateOnce(statePath, read);
  } catch (error) {
    if (!/unable to open database file|readonly database/.test(String(error))) throw error;
    return readCodexStateOnce(`file:${encodeURI(statePath)}?immutable=1`, read);
  }
}

export function readCodexSnapshot(statePath: string, includeClosed: boolean): CodexSnapshot {
  return withCodexState(statePath, (db) => ({
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
  }));
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

export function matchCodexThreads(
  chats: readonly WorkChatMatch[]
): ReadonlyMap<string, WorkChatMatch> {
  return new Map(
    chats.flatMap((chat) =>
      chat.kind === 'codex' && chat.sessionId ? [[chat.sessionId, chat] as const] : []
    )
  );
}

export function buildCodexGroups(
  snapshot: CodexSnapshot,
  query: FindQuery,
  deps: Omit<CodexDesktopAdapterDeps, 'statePath'>,
  matched: ReadonlyMap<string, WorkChatMatch> = new Map()
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
        .filter(
          (thread) =>
            placeMatches ||
            matched.has(thread.id) ||
            thread.title.toLowerCase().includes(text ?? '')
        )
        .map((thread) =>
          withChatEvidence(
            {
              ref: { adapter: 'codex-desktop', id: thread.id },
              title: thread.title,
              place: where,
              status: codexStatus(thread, now),
              lastActivityAt: thread.updatedAt,
              link: `codex://threads/${thread.id}`,
            },
            matched.get(thread.id)
          )
        )
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .slice(0, THREADS_PER_PLACE);
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
  .input(['query', 'deps', 'chats'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadCodexSnapshot, ['query', 'deps'], 'snapshot')
  .pipe(matchCodexThreads, 'chats', 'matched')
  .pipe(buildCodexGroups, ['snapshot', 'query', 'deps', 'matched'], 'groups')
  .end('groups') as (
  query: FindQuery,
  deps: CodexDesktopAdapterDeps,
  chats: readonly WorkChatMatch[]
) => PlaceGroup[];

export function readCodexThread(statePath: string, id: string): CodexThreadDetail | null {
  return withCodexState(statePath, (db) => {
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
  });
}

export async function readRolloutTail(path: string, bytes = ROLLOUT_TAIL_BYTES): Promise<string[]> {
  return (await readTailLines(path, bytes)).lines;
}

function parseLine(
  line: string
): { type?: unknown; payload?: Record<string, unknown>; timestamp?: unknown } | null {
  try {
    const entry = JSON.parse(line) as {
      type?: unknown;
      payload?: Record<string, unknown>;
      timestamp?: unknown;
    };
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

function withReplyAt(state: CodexTurnState, replyAt: number | undefined): CodexTurnState {
  return state.reply !== null && replyAt !== undefined ? { ...state, replyAt } : state;
}

export function codexTurnState(lines: readonly string[]): CodexTurnState {
  let reply: string | null = null;
  let replyAt: number | undefined;
  for (const line of [...lines].reverse()) {
    const entry = parseLine(line);
    const payload = entry?.payload ?? {};
    if (reply === null && entry?.type === 'response_item') {
      reply = messageText(payload, 'assistant');
      replyAt = workEntryTime(entry.timestamp);
    }
    if (entry?.type === 'event_msg' && TURN_MARKERS.has(String(payload.type))) {
      const marker = String(payload.type);
      return payload.type === 'task_complete' && typeof payload.last_agent_message === 'string'
        ? withReplyAt({ marker, reply: payload.last_agent_message }, workEntryTime(entry.timestamp))
        : withReplyAt({ marker, reply }, replyAt);
    }
  }
  return withReplyAt({ marker: null, reply }, replyAt);
}

export function codexRecentInputs(lines: readonly string[], since?: number): WorkInput[] {
  return recentWorkInputs(
    lines.flatMap((line) => {
      const entry = parseLine(line);
      if (entry?.type !== 'response_item') return [];
      const text = messageText(entry.payload ?? {}, 'user');
      if (!text || INJECTED_INPUT.test(text)) return [];
      const input = workInput(workEntryTime(entry.timestamp), text);
      return input ? [input] : [];
    }),
    since
  );
}

export function codexExchange(
  lines: readonly string[],
  since: number,
  truncated: boolean
): WorkExchange {
  const entries: WorkExchangeEntry[] = [];
  let earliest: number | undefined;
  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry) continue;
    const at = workEntryTime(entry.timestamp);
    earliest ??= at;
    const payload = entry.payload ?? {};
    const said = entry.type === 'response_item' ? messageText(payload, 'assistant') : null;
    const asked = entry.type === 'response_item' ? messageText(payload, 'user') : null;
    const final =
      entry.type === 'event_msg' &&
      payload.type === 'task_complete' &&
      typeof payload.last_agent_message === 'string'
        ? payload.last_agent_message
        : null;
    const next =
      said !== null
        ? exchangeEntry(at, 'agent', said, since)
        : asked !== null && !INJECTED_INPUT.test(asked)
          ? exchangeEntry(at, 'user', asked, since)
          : final !== null
            ? exchangeEntry(at, 'agent', final, since)
            : null;
    const last = entries.at(-1);
    if (next && !(final !== null && last?.role === 'agent' && last.text === next.text))
      entries.push(next);
  }
  return boundExchange(entries, truncated && (earliest === undefined || earliest > since));
}

export function activeCodexTurn(lines: readonly string[]): string | null | undefined {
  for (const line of [...lines].reverse()) {
    const entry = parseLine(line);
    const payload = entry?.payload ?? {};
    if (entry?.type === 'event_msg' && TURN_MARKERS.has(String(payload.type))) {
      return payload.type === 'task_started' && typeof payload.turn_id === 'string'
        ? payload.turn_id
        : null;
    }
  }
  return undefined;
}

async function readActiveCodexTurn(rolloutPath: string): Promise<string | null> {
  try {
    const recent = activeCodexTurn(await readRolloutTail(rolloutPath));
    if (recent !== undefined) return recent;
    return activeCodexTurn(await readRolloutTail(rolloutPath, Number.MAX_SAFE_INTEGER)) ?? null;
  } catch {
    return null;
  }
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

export async function readCodexTurn(
  detail: CodexThreadDetail,
  since?: number
): Promise<CodexTurnState> {
  try {
    const { lines, truncated } = await readTailLines(detail.thread.rolloutPath, ROLLOUT_TAIL_BYTES);
    return {
      ...codexTurnState(lines),
      inputs: codexRecentInputs(lines, since),
      ...(since !== undefined ? { exchange: codexExchange(lines, since, truncated) } : {}),
    };
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
      ...(state.reply && state.replyAt !== undefined ? { lastReplyAt: state.replyAt } : {}),
      ...(state.inputs ? { recentInputs: state.inputs } : {}),
      ...withExchange(state.exchange),
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
  .input(['ref', 'deps', 'since'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe(readCodexTurn, ['outcome', 'since'], 'turn')
  .pipe(describeCodexThread, ['outcome', 'turn', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  deps: CodexDesktopAdapterDeps,
  since: number | undefined
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
  return selectLocalStartFolder(request, deps, 'A Codex thread needs a folder to work in.');
}

export function startedThreadId(started: unknown): string | null {
  const value = started as { thread?: { id?: unknown }; threadId?: unknown } | null;
  const id = value?.thread?.id ?? value?.threadId;
  return typeof id === 'string' && id ? id : null;
}

interface CodexWorkFolder {
  cwd: string;
  release: () => Promise<void>;
}

async function runGit(args: string[], repo: string, deps: CodexDesktopAdapterDeps) {
  const proc = deps.spawn(['git', ...args], { cwd: repo, stdout: 'ignore', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr: stderr.trim() };
}

export async function prepareCodexWorkFolder(
  folder: string,
  deps: CodexDesktopAdapterDeps
): Promise<Result<CodexWorkFolder>> {
  const repo = await deps.gitRoot(folder).catch(() => null);
  if (!repo) return { ok: true, value: { cwd: folder, release: async () => {} } };
  const worktree = join(deps.worktreesDir, deps.newId().slice(0, 8), basename(repo));
  const added = await runGit(['worktree', 'add', '--detach', worktree, 'HEAD'], repo, deps);
  if (added.code !== 0) {
    return reject('not_delivered', `Could not create a worktree in ${repo}: ${added.stderr}`);
  }
  return {
    ok: true,
    value: {
      cwd: worktree,
      release: async () => {
        await runGit(['worktree', 'remove', '--force', worktree], repo, deps).catch(() => {});
      },
    },
  };
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
  let workFolder: CodexWorkFolder | null = null;
  try {
    const prepared = await prepareCodexWorkFolder(folder, deps);
    if (!prepared.ok) return prepared;
    workFolder = prepared.value;
    threadId = startedThreadId(await server.call('thread/start', { cwd: workFolder.cwd }));
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
    if (!threadId) await workFolder?.release();
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

export async function interruptCodexTurn(
  detail: CodexThreadDetail,
  deps: CodexDesktopAdapterDeps
): Promise<Result<{ stopped: boolean }>> {
  const threadId = detail.thread.id;
  const turnId = await readActiveCodexTurn(detail.thread.rolloutPath);
  if (!turnId) return { ok: true, value: { stopped: false } };
  let server: CodexAppServer;
  try {
    server = await deps.appServer();
  } catch (error) {
    return reject(
      'unreachable',
      `The Codex app-server is not running: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    await server.call('turn/interrupt', { threadId, turnId });
    return { ok: true, value: { stopped: true } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('thread not found')) {
      return reject(
        'unsupported',
        `Codex Desktop runs thread ${threadId} itself; stop it in the app.`
      );
    }
    return (await readActiveCodexTurn(detail.thread.rolloutPath)) === turnId
      ? reject('not_delivered', message)
      : { ok: true, value: { stopped: false } };
  } finally {
    server.close();
  }
}

const runCodexStop = (superpipe({})('codex-stop-work') as PipelineAPI)
  .input(['ref', 'deps'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe(interruptCodexTurn, ['outcome', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  deps: CodexDesktopAdapterDeps
) => Promise<Result<{ stopped: boolean }>>;

export function createCodexDesktopAdapter(deps: CodexDesktopAdapterDeps): WorkAdapter {
  return {
    id: 'codex-desktop',
    capabilities: ['find', 'start', 'send', 'status', 'stop'],
    find: async (query) =>
      runCodexFind(
        query,
        deps,
        query.text && !query.spaceId && deps.searchChats ? await deps.searchChats(query.text) : []
      ),
    start: (request) => runCodexStart(request, deps),
    send: (ref, message) => runCodexSend(ref, message, deps),
    status: (ref, since) => runCodexStatus(ref, deps, since),
    stop: (ref) => runCodexStop(ref, deps),
  };
}
