import {
  codexWorkerSandbox,
  prepareWorkerSandbox,
  releaseWorkerSandbox,
  resumeWorkerSandbox,
  workerSandboxOn,
} from './worker-sandbox.ts';
import { codexHeartbeatQuiet } from './codex-heartbeat.ts';
import { CODEX_WORKER_INSTRUCTIONS } from '@hyperneo/prompts';
import { Logger } from '../logger.ts';
import { runLagPhase } from '../event-loop-activity.ts';
import { workStartPreparation, type WorkExecutionPreparer } from './start-preparation.ts';
import { basename, join } from 'node:path';
import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  OWN_THREADS,
  THREAD_COLUMNS,
  withCodexState,
  readCodexSnapshot,
} from '../../storage/codex-desktop-read.ts';
export { readCodexSnapshot, withCodexState } from '../../storage/codex-desktop-read.ts';
import { gitWorktreeProject } from './acp-agent-adapter.ts';
import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import { CodexRequestError, type CodexAppServer } from './codex-app-server.ts';
import { selectCodexConfiguration } from './codex-start-configuration.ts';
import { workStartConfiguration } from './start-configuration.ts';
import { skipSpaceQuery } from './hyperneo-adapter.ts';
import { matchChatsBy } from './match-chats.ts';
import { withChatEvidence } from './places.ts';
import { selectLocalStartFolder } from './start-folder.ts';
import { workExecutionLocation } from './execution-location.ts';
import { codexOpenedPrs, createCodexPrReader } from './opened-prs.ts';
import { readTailLines } from './transcript-tail.ts';
import type {
  FindQuery,
  PlaceGroup,
  Rejected,
  Result,
  StartRequest,
  WorkAdapter,
  WorkDelivery,
  WorkDetail,
  WorkExchangeEntry,
  WorkInput,
  WorkRef,
  WorkStarted,
  WorkStatus,
  WorkSummary,
  WorkWithdrawal,
} from './types.ts';
import {
  boundExchange,
  WORK_AGENT_INPUT,
  exchangeEntry,
  recentWorkInputs,
  TURN_REPLIES,
  turnReplies,
  turnReply,
  type WorkExchange,
  withExchange,
  workEntryTime,
  workInput,
} from './work-messages.ts';
import { reject } from './work-operations.ts';
import { steerCodexDesktopTurn, type CodexSendGate } from './codex-desktop-handoff.ts';
import { type GitCheckout, planWorkPlacement } from './work-placement.ts';

const THREADS_PER_PLACE = 20;
const RECENT_MS = 2 * 60_000;
const ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024;
const QUEUE_TIMEOUT_MS = 30_000;
const START_RECEIPT_TRIES = 10;
const START_RECEIPT_WAIT_MS = 200;
const TURN_MARKERS = new Set(['task_started', 'task_complete', 'turn_aborted']);
const INJECTED_INPUT = /^<([a-z_]+)>[\s\S]*<\/\1>$/;
const CODEX_ASK_TOOL = 'request_user_input_async';

export interface CodexRootRow {
  projectId?: string;
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

const sendLog = new Logger('codex-send');

export interface CodexDesktopAdapterDeps {
  prepareExecution?: WorkExecutionPreparer;
  statePath: string;
  readSnapshot?: (statePath: string, includeClosed: boolean) => Promise<CodexSnapshot>;
  desktopSocketPath?: string;
  desktopRunning?: () => Promise<boolean>;
  worktreesDir: string;
  machine: string;
  now: () => number;
  spawn: SpawnFn;
  appServer: () => Promise<CodexAppServer>;
  bootstrapServer: () => Promise<CodexAppServer>;
  prepareDesktopProject: (folder: string) => Promise<string>;
  startDesktopTurn: (threadId: string, request: Record<string, unknown>) => Promise<void>;
  folderExists: (folder: string) => boolean;
  makeFolder: (folder: string) => void;
  homeDir: string;
  gitCheckout: (folder: string) => Promise<GitCheckout | null>;
  newId: () => string;
  searchChats?: (text: string) => Promise<readonly WorkChatMatch[]>;
}

export interface CodexThreadDetail {
  thread: CodexThreadRow & { rolloutPath: string; branch?: string | null };
  roots: CodexRootRow[];
  linkedPrs?: string[];
}

export interface CodexTurnState {
  turnEnds?: WorkDetail['turnEnds'];
  marker: string | null;
  outcome?: 'asked' | 'errored';
  reply: string | null;
  replyAt?: number;
  inputs?: WorkInput[];
  exchange?: WorkExchange;
  openedPrs?: string[];
}

type Gate<Value> = { value: Value } | { reason: Rejected };

interface CodexPlace extends CodexFolderRow {
  name: string;
  known: boolean;
}

export async function codexProjectFolder(
  folder: string,
  roots: readonly CodexRootRow[],
  worktreesDir: string
): Promise<string> {
  if (!folder.startsWith(`${worktreesDir}/`)) return folder;
  const project = await gitWorktreeProject(folder);
  return roots.some((root) => root.folder === project) ? project : folder;
}

function codexPlaces(snapshot: CodexSnapshot, folders: ReadonlyMap<string, string>): CodexPlace[] {
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
    const folder = folders.get(row.folder) ?? row.folder;
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
  return matchChatsBy(chats, (chat) => (chat.kind === 'codex' ? chat.sessionId : null));
}

async function resolveCodexFolders(snapshot: CodexSnapshot, deps: CodexDesktopAdapterDeps) {
  return runLagPhase('scanner:codex_desktop:worktrees', () =>
    Promise.all(
      [...new Set([...snapshot.folders, ...snapshot.threads].map((row) => row.folder))].map(
        async (folder) =>
          [folder, await codexProjectFolder(folder, snapshot.roots, deps.worktreesDir)] as const
      )
    ).then((entries) => new Map(entries))
  );
}

export function buildCodexGroups(
  snapshot: CodexSnapshot,
  query: FindQuery,
  deps: Omit<CodexDesktopAdapterDeps, 'statePath'>,
  matched: ReadonlyMap<string, WorkChatMatch>,
  folders: ReadonlyMap<string, string>
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  const now = deps.now();
  return codexPlaces(snapshot, folders)
    .filter((place) => !query.folder || place.folder === query.folder)
    .filter((place) => query.includeClosed || place.openCount > 0 || place.known)
    .flatMap((place) => {
      const placeMatches = !text || `${place.name} ${place.folder}`.toLowerCase().includes(text);
      const where = { machine: deps.machine, folder: place.folder, name: place.name };
      const project = snapshot.roots.find((root) => root.folder === place.folder);
      const toolProject = project?.projectId
        ? { id: `codex:${project.projectId}`, name: project.name }
        : undefined;
      const linked = { ...where, ...(toolProject ? { toolProject } : {}) };
      const work: WorkSummary[] = snapshot.threads
        .filter((thread) => folders.get(thread.folder) === place.folder)
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
              place: { ...linked, folder: thread.folder },
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
          place: linked,
          lastActivityAt: place.lastActiveAt,
          openCount: place.openCount,
          archivedCount: place.archivedCount,
          adapters: ['codex-desktop'],
          work,
        },
      ];
    });
}

export async function loadCodexSnapshot(
  query: FindQuery,
  deps: CodexDesktopAdapterDeps
): Promise<CodexSnapshot> {
  return runLagPhase('scanner:codex_desktop', () =>
    deps.readSnapshot
      ? deps.readSnapshot(deps.statePath, query.includeClosed)
      : readCodexSnapshot(deps.statePath, query.includeClosed)
  );
}

const runCodexFind = (superpipe({})('codex-find-work') as PipelineAPI)
  .input(['query', 'deps', 'chats'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadCodexSnapshot, ['query', 'deps'], 'snapshot')
  .pipe(matchCodexThreads, 'chats', 'matched')
  .pipe(resolveCodexFolders, ['snapshot', 'deps'], 'folders')
  .pipe(
    (
      snapshot: CodexSnapshot,
      query: FindQuery,
      deps: CodexDesktopAdapterDeps,
      matched: ReadonlyMap<string, WorkChatMatch>,
      folders: ReadonlyMap<string, string>
    ) =>
      runLagPhase('scanner:codex_desktop:groups', () =>
        buildCodexGroups(snapshot, query, deps, matched, folders)
      ),
    ['snapshot', 'query', 'deps', 'matched', 'folders'],
    'groups'
  )
  .endAsync('groups') as (
  query: FindQuery,
  deps: CodexDesktopAdapterDeps,
  chats: readonly WorkChatMatch[]
) => Promise<PlaceGroup[]>;

export function readCodexThread(statePath: string, id: string): CodexThreadDetail | null {
  return withCodexState(statePath, (db) => {
    const thread = db
      .prepare(
        `SELECT ${THREAD_COLUMNS}, rollout_path AS rolloutPath, ${
          db.prepare("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'git_branch'").get()
            ? 'git_branch'
            : 'NULL'
        } AS branch FROM threads
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
    const links = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_attachments'")
      .get()
      ? (db
          .prepare(
            `SELECT json_extract(payload, '$.url') AS url FROM thread_attachments
              WHERE thread_id = ? AND attachment_type = 'pull_request' ORDER BY created_at`
          )
          .all(id) as { url: string | null }[])
      : null;
    return {
      thread,
      roots,
      ...(links ? { linkedPrs: links.flatMap((row) => (row.url ? [row.url] : [])) } : {}),
    };
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

function completedTurnAsked(lines: readonly string[], end: number): boolean {
  for (let index = end - 1; index >= 0; index--) {
    const entry = parseLine(lines[index]);
    const payload = entry?.payload ?? {};
    if (entry?.type === 'event_msg' && TURN_MARKERS.has(String(payload.type))) return false;
    if (entry?.type !== 'response_item') continue;
    if (payload.type === 'function_call' && payload.name === CODEX_ASK_TOOL) return true;
    const asked = messageText(payload, 'user');
    if (asked !== null && !INJECTED_INPUT.test(asked)) return false;
  }
  return false;
}

function completedTurnOutcome(
  payload: Record<string, unknown>,
  lines: readonly string[],
  index: number
): Pick<CodexTurnState, 'outcome'> {
  if (payload.type !== 'task_complete') return {};
  if (payload.error) return { outcome: 'errored' };
  return completedTurnAsked(lines, index) ? { outcome: 'asked' } : {};
}

export function codexTurnState(lines: readonly string[]): CodexTurnState {
  let end: Pick<CodexTurnState, 'marker' | 'outcome'> | null = null;
  const said: string[] = [];
  let replyAt: number | undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = parseLine(lines[index]);
    const payload = entry?.payload ?? {};
    const marker = entry?.type === 'event_msg' && TURN_MARKERS.has(String(payload.type));
    if (marker && end) break;
    if (marker)
      end = { marker: String(payload.type), ...completedTurnOutcome(payload, lines, index) };
    const text =
      entry?.type === 'response_item'
        ? messageText(payload, 'assistant')
        : marker && typeof payload.last_agent_message === 'string'
          ? payload.last_agent_message
          : null;
    if (text && said[0] !== text) {
      said.unshift(text);
      replyAt ??= workEntryTime(entry?.timestamp);
    }
    if (payload.type === 'task_started' && marker) break;
  }
  return withReplyAt({ marker: null, ...end, reply: turnReply(said) }, replyAt);
}

export function codexRecentInputs(lines: readonly string[], since?: number): WorkInput[] {
  return recentWorkInputs(
    lines.flatMap((line) => {
      const entry = parseLine(line);
      if (entry?.type !== 'response_item') return [];
      const text = messageText(entry.payload ?? {}, 'user');
      if (!text || INJECTED_INPUT.test(text)) return [];
      const input = workInput(
        workEntryTime(entry.timestamp),
        text,
        !text.includes(WORK_AGENT_INPUT) &&
          !text.includes('Neo routed this to you:') &&
          !text.startsWith('# AGENTS.md instructions')
      );
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
  if (state.marker !== 'task_complete') return codexStatus(thread, now);
  if (state.outcome === 'errored') return 'failed';
  return state.outcome === 'asked' ? 'needs_you' : 'done';
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
  since?: number,
  readOpenedPrs?: ReturnType<typeof createCodexPrReader>
): Promise<CodexTurnState> {
  try {
    const { lines, truncated } = await readTailLines(detail.thread.rolloutPath, ROLLOUT_TAIL_BYTES);
    const openedPrs = readOpenedPrs
      ? readOpenedPrs(detail.thread.rolloutPath, lines)
      : codexOpenedPrs(lines);
    let startedAt: number | undefined;
    const turnEnds = lines.flatMap((line, index) => {
      const entry = parseLine(line),
        payload = entry?.payload ?? {},
        at = workEntryTime(entry?.timestamp);
      if (entry?.type === 'event_msg' && payload.type === 'task_started') startedAt = at;
      const turnStartedAt = startedAt;
      if (entry?.type === 'event_msg' && payload.type === 'task_complete') startedAt = undefined;
      return entry?.type === 'event_msg' &&
        payload.type === 'task_complete' &&
        at !== undefined &&
        at > (since ?? -Infinity)
        ? [
            {
              id:
                typeof payload.turn_id === 'string' && payload.turn_id
                  ? payload.turn_id
                  : String(at),
              at,
              startedAt: turnStartedAt,
              ...(codexHeartbeatQuiet(payload.last_agent_message) &&
              !completedTurnOutcome(payload, lines, index).outcome
                ? { notify: false as const }
                : {}),
              message:
                typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '',
            },
          ]
        : [];
    });
    return {
      ...codexTurnState(lines),
      ...(turnEnds.length ? { turnEnds } : {}),
      inputs: codexRecentInputs(lines, since),
      ...(since !== undefined ? { exchange: codexExchange(lines, since, truncated) } : {}),
      ...(openedPrs.length ? { openedPrs } : {}),
    };
  } catch {
    return { marker: null, reply: null };
  }
}

export async function describeCodexThread(
  detail: CodexThreadDetail,
  state: CodexTurnState,
  deps: CodexDesktopAdapterDeps
): Promise<Result<WorkDetail>> {
  const { thread, roots } = detail;
  const folder = await codexProjectFolder(thread.folder, roots, deps.worktreesDir);
  const root = roots.find((candidate) => candidate.folder === folder);
  return {
    ok: true,
    value: {
      ref: { adapter: 'codex-desktop', id: thread.id },
      title: thread.title,
      place: { machine: deps.machine, folder, name: root?.name || basename(folder) || folder },
      ...workExecutionLocation(thread.folder, deps.machine),
      status: turnStatus(thread, state, deps.now()),
      ...(state.turnEnds?.length ? { turnEnds: state.turnEnds } : {}),
      lastActivityAt: thread.updatedAt,
      link: `codex://threads/${thread.id}`,
      ...(state.reply ? { lastReply: state.reply } : {}),
      ...(state.reply && state.replyAt !== undefined ? { lastReplyAt: state.replyAt } : {}),
      ...(state.inputs ? { recentInputs: state.inputs } : {}),
      ...withExchange(state.exchange),
      ...(state.openedPrs ? { openedPrs: state.openedPrs } : {}),
      ...(detail.linkedPrs ? { linkedPrs: detail.linkedPrs.map((url) => ({ url })) } : {}),
      ...(thread.branch ? { branches: [thread.branch] } : {}),
    },
  };
}

type CodexReceipt = NonNullable<WorkDelivery['receipt']>;
type CodexInputEvidence = NonNullable<WorkDetail['inputEvidence']>;

function codexUserInput(
  entry: ReturnType<typeof parseLine>
): { id: string; text: string; at: number | undefined } | null {
  const payload = entry?.type === 'response_item' ? (entry.payload ?? {}) : null;
  const text = payload ? messageText(payload, 'user') : null;
  if (!payload || text === null || INJECTED_INPUT.test(text) || typeof payload.id !== 'string')
    return null;
  return payload.id ? { id: payload.id, text, at: workEntryTime(entry?.timestamp) } : null;
}

export function codexUserInputIds(lines: readonly string[]): Set<string> {
  return new Set(lines.flatMap((line) => codexUserInput(parseLine(line))?.id ?? []));
}

export function codexQueueDelivery(
  lines: readonly string[],
  message: string,
  threadId: string,
  before: ReadonlySet<string>,
  inputId: string
): WorkDelivery {
  const fresh = lines
    .map((line) => codexUserInput(parseLine(line)))
    .findLast(
      (input) =>
        !!input && input.id === inputId && !before.has(input.id) && input.text === message.trim()
    );
  return {
    delivered: !!fresh,
    ...(fresh ? { receipt: { executionId: threadId, inputId: fresh.id } } : {}),
  };
}

export function codexStartReceipt(
  lines: readonly string[],
  message: string,
  threadId: string
): CodexReceipt | null {
  const opening = message.trim().split('\n')[0].slice(0, 200);
  const input = lines
    .map((line) => codexUserInput(parseLine(line)))
    .find((candidate) => !!candidate && candidate.text.includes(opening));
  return input ? { executionId: threadId, inputId: input.id } : null;
}

function startedRolloutPath(started: unknown): string | null {
  const path = (started as { thread?: { path?: unknown } } | null)?.thread?.path;
  return typeof path === 'string' && path ? path : null;
}

function storedRolloutPath(statePath: string, threadId: string): string | null {
  try {
    return readCodexThread(statePath, threadId)?.thread.rolloutPath ?? null;
  } catch {
    return null;
  }
}

export async function readCodexStartReceipt(
  reported: string | null,
  message: string,
  threadId: string,
  statePath: string
): Promise<CodexReceipt | null> {
  for (let attempt = 1; attempt <= START_RECEIPT_TRIES; attempt++) {
    const path = reported ?? storedRolloutPath(statePath, threadId);
    if (!path) return null;
    const lines = await readRolloutTail(path).catch(() => []);
    const receipt = codexStartReceipt(lines, message, threadId);
    if (receipt || attempt === START_RECEIPT_TRIES) return receipt;
    await new Promise((resolve) => setTimeout(resolve, START_RECEIPT_WAIT_MS));
  }
  return null;
}

export function codexInputEvidence(
  lines: readonly string[],
  receipt: CodexReceipt,
  threadId: string
): CodexInputEvidence {
  const unavailable: CodexInputEvidence = { receipt, state: 'unavailable' };
  if (receipt.executionId !== threadId) return unavailable;
  const start = lines.findIndex((line) => codexUserInput(parseLine(line))?.id === receipt.inputId);
  const input = start < 0 ? null : codexUserInput(parseLine(lines[start]));
  const first = input ? exchangeEntry(input.at, 'user', input.text, -Infinity) : null;
  if (!first) return unavailable;
  const replies: WorkExchangeEntry[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) return unavailable;
    if (codexUserInput(entry)) break;
    const payload = entry.payload ?? {};
    const said =
      entry.type === 'response_item'
        ? messageText(payload, 'assistant')
        : entry.type === 'event_msg' &&
            payload.type === 'task_complete' &&
            typeof payload.last_agent_message === 'string'
          ? payload.last_agent_message
          : null;
    const reply = said
      ? exchangeEntry(workEntryTime(entry.timestamp), 'agent', said, -Infinity)
      : null;
    if (reply && replies.at(-1)?.text !== reply.text) replies.push(reply);
  }
  return {
    receipt,
    state: 'observed',
    exchange: [first, ...turnReplies(replies)],
    exchangeCut: replies.length > TURN_REPLIES,
  };
}

export async function readCodexInputEvidence(
  detail: CodexThreadDetail,
  receipt: CodexReceipt | undefined
): Promise<CodexInputEvidence | null> {
  if (!receipt) return null;
  try {
    return codexInputEvidence(
      await readRolloutTail(detail.thread.rolloutPath),
      receipt,
      detail.thread.id
    );
  } catch {
    return { receipt, state: 'unavailable' };
  }
}

export function withCodexInputEvidence(
  outcome: Result<WorkDetail>,
  evidence: CodexInputEvidence | null
): Result<WorkDetail> {
  return outcome.ok && evidence
    ? { ok: true, value: { ...outcome.value, inputEvidence: evidence } }
    : outcome;
}

async function queueCodexCliMessage(
  detail: CodexThreadDetail,
  message: string,
  deps: CodexDesktopAdapterDeps
): Promise<Result<WorkDelivery>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = deps.spawn(
      ['codex', 'queue', `--thread=${detail.thread.id}`, `--message=${message}`],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    timer = setTimeout(() => proc.kill(), QUEUE_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      return reject('not_delivered', stderr.trim() || `codex queue exited with ${code}.`);
    }
    return {
      ok: true,
      value: {
        delivered: false,
        ...(stdout.trim() ? { queuedSubmissionId: stdout.trim() } : {}),
      },
    };
  } catch (error) {
    return reject('not_delivered', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

async function withCodexMessageServer<Value>(
  deps: CodexDesktopAdapterDeps,
  use: (server: CodexAppServer) => Promise<Result<Value>>
): Promise<Result<Value>> {
  try {
    return await withCodexAppServer(deps, use);
  } catch (error) {
    return reject('not_delivered', error instanceof Error ? error.message : String(error));
  }
}

export async function queueCodexMessage(
  detail: CodexThreadDetail,
  message: string,
  deps: CodexDesktopAdapterDeps
): Promise<Result<WorkDelivery>> {
  const sandbox = await resumeWorkerSandbox(detail.thread.folder);
  sendLog.warn('work.send route', {
    threadId: detail.thread.id,
    path: 'queue',
    reason: 'native_queue',
  });
  const queued = await withCodexMessageServer<WorkDelivery>(deps, async (server) => {
    let step = 'thread/loaded/list';
    try {
      let cursor: string | null = null;
      let loaded = false;
      do {
        const page = z
          .object({ data: z.array(z.string()), nextCursor: z.string().nullish() })
          .parse(await server.call(step, { cursor }));
        loaded = page.data.includes(detail.thread.id);
        cursor = page.nextCursor ?? null;
      } while (!loaded && cursor);
      if (!loaded) {
        step = 'thread/resume';
        await server.call(step, {
          threadId: detail.thread.id,
          ...(sandbox ? { sandboxPolicy: sandbox.sandboxPolicy } : {}),
        });
      }
      if (sandbox) {
        step = 'thread/settings/update';
        await server.call(step, {
          threadId: detail.thread.id,
          sandboxPolicy: sandbox.sandboxPolicy,
        });
      }
    } catch (error) {
      return reject('not_delivered', `${step}: ${String(error)}`, true);
    }
    const before = codexUserInputIds(
      await readRolloutTail(detail.thread.rolloutPath).catch(() => [])
    );
    const clientUserMessageId = deps.newId();
    let added: unknown;
    try {
      added = await server.call('thread/queue/add', {
        threadId: detail.thread.id,
        clientUserMessageId,
        input: [{ type: 'text', text: message }],
      });
    } catch (error) {
      if (
        /-32601|unknown method|method not found|unrecognized (?:request|method)/i.test(
          String(error)
        )
      )
        return queueCodexCliMessage(detail, message, deps);
      if (
        error instanceof CodexRequestError &&
        z
          .object({
            code: z.literal(-32600),
            message: z.string().includes(`thread ${detail.thread.id} already has an active writer`),
          })
          .safeParse(error.rejection).success
      )
        return reject('not_delivered', error.message, true);
      return reject('not_delivered', `thread/queue/add: ${String(error)}`);
    }
    const parsed = z
      .object({
        queuedSubmission: z.object({ id: z.string().min(1) }),
      })
      .safeParse(added);
    if (!parsed.success)
      return reject('not_delivered', `thread/queue/add: ${parsed.error.message}`);
    const { queuedSubmission } = parsed.data;
    const delivery = codexQueueDelivery(
      await readRolloutTail(detail.thread.rolloutPath).catch(() => []),
      message,
      detail.thread.id,
      before,
      clientUserMessageId
    );
    return {
      ok: true,
      value: {
        ...delivery,
        delivered: !!delivery.receipt,
        queuedSubmissionId: queuedSubmission.id,
      },
    };
  });
  sendLog.warn('work.send queue result', { threadId: detail.thread.id, result: queued });
  return !sandbox && !queued.ok && queued.reason === 'unreachable'
    ? queueCodexCliMessage(detail, message, deps)
    : queued;
}

export function admitCodexSteerTurn(read: unknown): Gate<string> {
  const turn = z
    .object({
      data: z.array(z.object({ id: z.string().min(1), status: z.string() })),
    })
    .parse(read).data[0];
  return turn?.status === 'inProgress'
    ? { value: turn.id }
    : { reason: reject('not_delivered', 'The Codex thread has no running turn to steer.') };
}

async function callCodexSteer(
  server: CodexAppServer,
  threadId: string,
  turnId: string,
  message: string
): Promise<Result<WorkDelivery>> {
  const steered = z.object({ turnId: z.literal(turnId) }).parse(
    await server.call('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: message }],
    })
  );
  return { ok: true, value: { delivered: true, steeredIntoTurnId: steered.turnId } };
}

async function tryDesktopCodexSend(
  detail: CodexThreadDetail,
  message: string,
  deps: CodexDesktopAdapterDeps,
  mode: 'steer'
): Promise<CodexSendGate<'app-server'>> {
  await resumeWorkerSandbox(detail.thread.folder);
  return steerCodexDesktopTurn(
    deps.desktopSocketPath,
    deps.spawn,
    detail.thread.id,
    message,
    deps.newId(),
    mode,
    deps.desktopRunning
  );
}

async function tryServerCodexSend(
  route: 'app-server',
  detail: CodexThreadDetail,
  message: string,
  deps: CodexDesktopAdapterDeps,
  mode: 'steer'
): Promise<CodexSendGate<never>> {
  sendLog.warn('work.send route', { threadId: detail.thread.id, path: route, mode });
  let attempted = false;
  const result = await withCodexMessageServer<WorkDelivery>(deps, async (server) => {
    const turn = admitCodexSteerTurn(
      await server.call('thread/turns/list', { threadId: detail.thread.id, limit: 1 })
    );
    if ('reason' in turn) return turn.reason;
    attempted = true;
    return callCodexSteer(server, detail.thread.id, turn.value, message);
  });
  sendLog.warn('work.send app-server result', { threadId: detail.thread.id, mode, result });
  return {
    reason: !result.ok
      ? reject('not_delivered', result.detail, attempted ? undefined : true)
      : result,
  };
}

export function codexWithdrawal(queuedSubmissionId: string, withdrawn: boolean): WorkWithdrawal {
  return {
    queuedSubmissionId,
    withdrawn,
    ...(!withdrawn ? { reason: 'not_queued' as const } : {}),
  };
}

export async function withdrawCodexMessage(
  detail: CodexThreadDetail,
  queuedSubmissionId: string,
  deps: CodexDesktopAdapterDeps
): Promise<Result<WorkWithdrawal>> {
  return withCodexMessageServer(deps, async (server) => {
    const threadId = detail.thread.id;
    const listed = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .parse(await server.call('thread/queue/list', { threadId }));
    const deleted = listed.data.some((item) => item.id === queuedSubmissionId)
      ? z
          .object({ deleted: z.boolean() })
          .parse(await server.call('thread/queue/delete', { threadId, queuedSubmissionId })).deleted
      : false;
    return { ok: true, value: codexWithdrawal(queuedSubmissionId, deleted) };
  });
}

const runCodexStatus = (superpipe({})('codex-work-status') as PipelineAPI)
  .input(['ref', 'deps', 'since', 'receipt', 'readOpenedPrs'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe((detail: CodexThreadDetail) => detail, 'outcome', 'detail')
  .pipe(readCodexTurn, ['detail', 'since', 'readOpenedPrs'], 'turn')
  .pipe(readCodexInputEvidence, ['detail', 'receipt'], 'evidence')
  .pipe(describeCodexThread, ['detail', 'turn', 'deps'], 'outcome')
  .pipe(withCodexInputEvidence, ['outcome', 'evidence'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  deps: CodexDesktopAdapterDeps,
  since: number | undefined,
  receipt: CodexReceipt | undefined,
  readOpenedPrs: ReturnType<typeof createCodexPrReader>
) => Promise<Result<WorkDetail>>;

const runCodexSend = (superpipe({})('codex-send-work') as PipelineAPI)
  .input(['ref', 'message', 'deps', 'mode'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe(requireOpenCodexThread, 'outcome', 'result:outcome')
  .pipe((detail: CodexThreadDetail) => detail, 'outcome', 'detail')
  .pipe(tryDesktopCodexSend, ['detail', 'message', 'deps', 'mode'], 'result:outcome')
  .pipe(tryServerCodexSend, ['outcome', 'detail', 'message', 'deps', 'mode'], 'result:outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  deps: CodexDesktopAdapterDeps,
  mode: 'steer'
) => Promise<Result<WorkDelivery>>;

const runCodexRename = (superpipe({})('codex-rename-work') as PipelineAPI)
  .input(['ref', 'title', 'deps'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe(requireOpenCodexThread, 'outcome', 'result:outcome')
  .pipe(
    (detail: CodexThreadDetail, title: string, deps: CodexDesktopAdapterDeps) =>
      withCodexMessageServer(deps, async (server) => {
        await server.call('thread/name/set', { threadId: detail.thread.id, name: title });
        return { ok: true, value: { renamed: true as const, title } };
      }),
    ['outcome', 'title', 'deps'],
    'outcome'
  )
  .endAsync('outcome') as (
  ref: WorkRef,
  title: string,
  deps: CodexDesktopAdapterDeps
) => Promise<Result<{ renamed: true; title: string }>>;

const runCodexQueue = (superpipe({})('codex-queue-work') as PipelineAPI)
  .input(['ref', 'message', 'deps'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe(requireOpenCodexThread, 'outcome', 'result:outcome')
  .pipe(queueCodexMessage, ['outcome', 'message', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  deps: CodexDesktopAdapterDeps
) => Promise<Result<WorkDelivery>>;

const runCodexWithdraw = (superpipe({})('codex-withdraw-work') as PipelineAPI)
  .input(['ref', 'queuedSubmissionId', 'deps'])
  .pipe(requireCodexThread, ['ref', 'deps'], 'result:outcome')
  .pipe(withdrawCodexMessage, ['outcome', 'queuedSubmissionId', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  queuedSubmissionId: string,
  deps: CodexDesktopAdapterDeps
) => Promise<Result<WorkWithdrawal>>;

export function selectCodexStartFolder(
  request: StartRequest,
  deps: CodexDesktopAdapterDeps
): Gate<string> {
  const admitted = workStartPreparation.admit(request.preparation, !!deps.prepareExecution);
  if ('reason' in admitted) return admitted;
  return selectLocalStartFolder(request, deps, 'A Codex thread needs a folder to work in.', true);
}

export function startedThreadId(started: unknown): string | null {
  const value = started as { thread?: { id?: unknown }; threadId?: unknown } | null;
  const id = value?.thread?.id ?? value?.threadId;
  return typeof id === 'string' && id ? id : null;
}

function startedThreadModel(started: unknown): string | undefined {
  const model = (started as { model?: unknown } | null)?.model;
  return typeof model === 'string' && model.trim() ? model : undefined;
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
  deps: CodexDesktopAdapterDeps,
  inPlace = false
): Promise<Result<CodexWorkFolder>> {
  const placement = planWorkPlacement(
    inPlace ? null : await deps.gitCheckout(folder).catch(() => null)
  );
  if (placement.kind === 'in_place') {
    return { ok: true, value: { cwd: folder, release: async () => {} } };
  }
  const { repo } = placement;
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

export async function withCodexAppServer<Value>(
  deps: Pick<CodexDesktopAdapterDeps, 'appServer'>,
  use: (server: CodexAppServer) => Promise<Result<Value>>
): Promise<Result<Value>> {
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
    return await use(server);
  } finally {
    await server.close();
  }
}

export async function startCodexThread(
  folder: string,
  request: StartRequest,
  deps: CodexDesktopAdapterDeps
): Promise<Result<WorkStarted>> {
  return withCodexAppServer({ appServer: deps.bootstrapServer }, async (server) => {
    let threadId: string | null = null;
    let workFolder: CodexWorkFolder | null = null;
    try {
      const configuration = await selectCodexConfiguration(
        { model: request.model, effort: request.effort },
        server
      );
      if (!configuration.ok) return configuration;
      const folderReady = request.prepareFolder?.();
      if (folderReady && 'reason' in folderReady) return folderReady.reason;
      if (request.preparation) {
        const prepared = await deps.prepareExecution!(request.preparation, {
          directory: folder,
          destination: join(deps.worktreesDir, deps.newId().slice(0, 8), basename(folder)),
        });
        if (!prepared.ok) return prepared;
        workFolder = { cwd: prepared.value.directory, release: prepared.value.release };
      } else {
        const prepared = await prepareCodexWorkFolder(folder, deps, request.inPlace);
        if (!prepared.ok) return prepared;
        workFolder = prepared.value;
      }
      const sandbox =
        request.preparation && workerSandboxOn(request.preparation.sandbox)
          ? codexWorkerSandbox(workFolder.cwd)
          : null;
      if (sandbox) await prepareWorkerSandbox(workFolder.cwd);
      const projectFolder = request.inPlace
        ? folder
        : ((await deps.gitCheckout(folder))?.repo ?? folder);
      const projectId = await deps.prepareDesktopProject(projectFolder);
      const config = {
        ...sandbox?.config,
        ...(configuration.value.effort
          ? { model_reasoning_effort: configuration.value.effort }
          : {}),
      };
      const started = await server.call('thread/start', {
        projectId,
        cwd: workFolder.cwd,
        approvalPolicy: 'never',
        sandbox: sandbox?.sandbox ?? 'danger-full-access',
        ...(sandbox || configuration.value.effort ? { config } : {}),
        ...(configuration.value.model ? { model: configuration.value.model } : {}),
      });
      threadId = startedThreadId(started);
      if (!threadId) return reject('not_delivered', 'thread/start returned no thread id.');
      const model = startedThreadModel(started);
      const reportedEffort = (started as { reasoningEffort?: unknown } | null)?.reasoningEffort;
      const effort =
        typeof reportedEffort === 'string' && reportedEffort.trim() ? reportedEffort : undefined;
      const confirmed = workStartConfiguration.confirm(configuration.value, { model, effort });
      if (!confirmed.ok) {
        return reject(
          confirmed.reason,
          `${confirmed.detail} Thread ${threadId} was created without its first turn.`
        );
      }
      await server.call('thread/name/set', { threadId, name: request.title });
      await server.close();
      const message = `${request.message}\n${CODEX_WORKER_INSTRUCTIONS}`;
      await deps.startDesktopTurn(threadId, {
        threadId,
        approvalPolicy: 'never',
        sandboxPolicy: sandbox?.sandboxPolicy ?? { type: 'dangerFullAccess' },
        input: [{ type: 'text', text: message, text_elements: [] }],
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      const receipt = await readCodexStartReceipt(
        startedRolloutPath(started),
        message,
        threadId,
        deps.statePath
      );
      return {
        ok: true,
        value: {
          ref: { adapter: 'codex-desktop', id: threadId },
          title: request.title,
          place: { machine: deps.machine, folder, name: request.place.name },
          status: 'running',
          lastActivityAt: deps.now(),
          link: `codex://threads/${threadId}`,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(receipt ? { receipt } : {}),
        },
      };
    } catch (error) {
      const made = threadId
        ? ` Thread ${threadId} was created, but its opening turn was not confirmed.`
        : '';
      return reject(
        'not_delivered',
        `${error instanceof Error ? error.message : String(error)}${made}`
      );
    } finally {
      if (!threadId) {
        await workFolder?.release();
        if (request.preparation) await releaseWorkerSandbox(workFolder?.cwd);
      }
    }
  });
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
  return withCodexAppServer<{ stopped: boolean }>(deps, async (server) => {
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
    }
  });
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
  const readOpenedPrs = createCodexPrReader();
  return {
    id: 'codex-desktop',
    supportsStartPreparation: !!deps.prepareExecution,
    supportsStartEffort: true,
    capabilities: [
      'find',
      'start',
      'rename',
      'send',
      'steer',
      'queue',
      'withdraw',
      'status',
      'stop',
      'archive',
    ],
    find: async (query) =>
      runCodexFind(
        query,
        deps,
        query.text && !query.spaceId && deps.searchChats ? await deps.searchChats(query.text) : []
      ),
    start: (request) => runCodexStart(request, deps),
    rename: (ref, title) => runCodexRename(ref, title, deps),
    send: (ref, message, context) =>
      runCodexQueue(
        ref,
        context.from === 'chat' ? message : `${message}\n${WORK_AGENT_INPUT}`,
        deps
      ),
    steer: (ref, message, context) =>
      runCodexSend(
        ref,
        context.from === 'chat' ? message : `${message}\n${WORK_AGENT_INPUT}`,
        deps,
        'steer'
      ),
    queue: (ref, message, context) =>
      runCodexQueue(
        ref,
        context.from === 'chat' ? message : `${message}\n${WORK_AGENT_INPUT}`,
        deps
      ),
    withdraw: (ref, queuedSubmissionId) => runCodexWithdraw(ref, queuedSubmissionId, deps),
    status: (ref, since, receipt) => runCodexStatus(ref, deps, since, receipt, readOpenedPrs),
    stop: (ref) => runCodexStop(ref, deps),
    archive: async (ref, admit) => {
      const found = requireCodexThread(ref, deps);
      if ('reason' in found) return found.reason;
      if (found.value.thread.archived) {
        const refused = admit();
        if (refused) return refused;
        await releaseWorkerSandbox(found.value.thread.folder);
        return { ok: true, value: { archived: false } };
      }
      return withCodexAppServer(deps, async (server) => {
        const read = z
          .object({
            thread: z.object({ id: z.literal(ref.id), status: z.object({ type: z.string() }) }),
          })
          .parse(await server.call('thread/read', { threadId: ref.id }));
        if (
          read.thread.status.type === 'active' ||
          (await readActiveCodexTurn(found.value.thread.rolloutPath))
        )
          return reject('busy', 'The Codex thread still has a live turn.');
        if (!['idle', 'notLoaded'].includes(read.thread.status.type))
          return reject('unreachable', 'Codex cannot confirm an idle thread.');
        const refused = admit();
        if (refused) return refused;
        await releaseWorkerSandbox(found.value.thread.folder);
        await server.call('thread/archive', { threadId: ref.id });
        return { ok: true, value: { archived: true } };
      });
    },
  };
}
