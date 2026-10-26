import { releaseWorkerSandbox, workerSandboxOn } from './worker-sandbox.ts';
import { createHash } from 'node:crypto';
import { getDataDir } from '../data-dir.ts';
import { installClaudeNativeWrites, readClaudeWorkerSandbox } from './claude-native-writes.ts';
import { collectDescendantPids, listProcesses, type ProcessLister } from '../process-watchdog.ts';
import { readClaudeReceiverMode } from './claude-receiver-mode.ts';
import { runLagPhase } from '../event-loop-activity.ts';
import { workStartPreparation, type WorkExecutionPreparer } from './start-preparation.ts';
import type { createClaudeDesktopModsDriver } from './claude-desktop-mods-driver.ts';
import {
  CLAUDE_DESKTOP_PREPARE,
  CLAUDE_DESKTOP_RELAY,
  CLAUDE_DESKTOP_WAKE_REQUEST,
  fillPrompt,
} from '@hyperneo/prompts';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
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
  WorkCallContext,
  WorkDelivery,
  WorkDetail,
  WorkStarted,
  WorkExchangeEntry,
  WorkInput,
  WorkRef,
  WorkStatus,
  WorkSummary,
  WorkWithdrawal,
  ArchiveAdmission,
} from './types.ts';
import { selectLocalStartFolder } from './start-folder.ts';
import { workExecutionLocation } from './execution-location.ts';
import { reject } from './work-operations.ts';
import {
  boundExchange,
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
import { matchChatsBy } from './match-chats.ts';
import { claudeOpenedPrs } from './opened-prs.ts';
import { readTailLines } from './transcript-tail.ts';
import { claudeInboxText, type ClaudeInboxSubmission } from './claude-inbox.ts';
import { planWorkPlacement, type GitCheckout } from './work-placement.ts';
import {
  readClaudeSessionOwner,
  requireClaudePeerOwner,
  type ClaudeSessionOwner,
} from './claude-session-owner.ts';

const SESSIONS_PER_PLACE = 20;
const LIVE_TIMEOUT_MS = 5_000;
const LIVE_REUSE_MS = 5_000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
const BOOTSTRAP_TIMEOUT_MS = 120_000;
const RELAY_TIMEOUT_MS = 120_000;
const DELIVERY_POLL_MS = 2_000;
const DELIVERY_POLLS = 15;
const OPEN_WAIT_MS = 60_000;
const OPEN_POLL_MS = 2_000;

const DESKTOP_UI_UNCONFIRMED = {
  state: 'ui-unconfirmed' as const,
  detail:
    'No supported live Desktop render/read acknowledgment is available. The transcript can advance while the Desktop view remains stale; registration, links and Remote Control do not confirm rendering or reading.',
};

const RecordSchema = z.object({
  sessionId: z.string().startsWith('local_'),
  cliSessionId: z.string().optional(),
  originCwd: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().default(''),
  isArchived: z.boolean().default(false),
  lastActivityAt: z.number().default(0),
  permissionMode: z.string().optional(),
  remoteControlUserEnabled: z.boolean().optional(),
  bridgeSessionIds: z.array(z.string()).optional(),
  prs: z
    .array(
      z.object({ url: z.string(), dismissed: z.boolean().optional(), own: z.boolean().optional() })
    )
    .optional()
    .catch(undefined),
  branch: z.string().optional().catch(undefined),
  writtenBranches: z.array(z.string()).optional().catch(undefined),
});

const LiveSessionSchema = z.object({
  sessionId: z.string(),
  pid: z.number().int().positive().optional(),
  status: z.string(),
  name: z
    .string()
    .nullish()
    .transform((name) => name ?? undefined),
  waitingFor: z
    .string()
    .nullish()
    .transform((waitingFor) => waitingFor?.slice(0, 200) || undefined),
});

export type ClaudeDesktopRecord = z.infer<typeof RecordSchema> & { desktopRegistered?: true };
type ClaudeTranscriptLocation = Pick<ClaudeDesktopRecord, 'cliSessionId' | 'cwd' | 'originCwd'>;
export interface ClaudeLiveSession {
  sessionId: string;
  pid?: number;
  owner?: ClaudeSessionOwner;
  status: string;
  name?: string;
  waitingFor?: string;
}

export interface ClaudeDesktopAdapterDeps {
  mods?: NonNullable<ReturnType<typeof createClaudeDesktopModsDriver>>['ready'];
  admitInbox?: (context: WorkCallContext) => Gate<string>;
  sendInbox?: (
    sessionId: string,
    message: string,
    context: WorkCallContext,
    fromMode?: ClaudeInboxSubmission['fromMode']
  ) => Promise<Result<WorkDelivery>>;
  prepareExecution?: WorkExecutionPreparer;
  sessionsDir: string;
  projectsDir: string;
  machine: string;
  liveSessions: () => Promise<readonly ClaudeLiveSession[]>;
  listProcesses?: ProcessLister;
  spawn: SpawnFn;
  folderExists: (folder: string) => boolean;
  makeFolder: (folder: string) => void;
  homeDir: string;
  gitCheckout: (folder: string) => Promise<GitCheckout | null>;
  newId: () => string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  searchChats?: (text: string) => Promise<readonly WorkChatMatch[]>;
  permissionMode?: () => string;
}

type Gate<Value> = { value: Value } | { reason: Rejected };

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

export type ClaudeRecordCache = Map<string, { modifiedAt: number; records: ClaudeDesktopRecord[] }>;
const STARTED_KEY = 'started:';

async function readRecord(path: string, cache: ClaudeRecordCache): Promise<ClaudeDesktopRecord[]> {
  try {
    const modifiedAt = (await stat(path)).mtimeMs;
    const cached = cache.get(path);
    if (cached?.modifiedAt === modifiedAt) return cached.records;
    const record = RecordSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    const records: ClaudeDesktopRecord[] = record.success
      ? [{ ...record.data, desktopRegistered: true }]
      : [];
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
  for (const path of cache.keys())
    if (!present.has(path) && !path.startsWith(STARTED_KEY)) cache.delete(path);
  const records = (await Promise.all(files.map((path) => readRecord(path, cache)))).flat();
  const registered = new Set(records.map((record) => record.sessionId));
  const started = [...cache].flatMap(([key, entry]) => {
    if (!key.startsWith(STARTED_KEY)) return [];
    if (!registered.has(key.slice(STARTED_KEY.length))) return entry.records;
    cache.delete(key);
    return [];
  });
  return [...records, ...started];
}

export async function readLiveClaudeSessions(
  spawn: SpawnFn,
  registrationsDir = join(homedir(), '.claude', 'sessions')
): Promise<ClaudeLiveSession[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = spawn(['claude', 'agents', '--json'], { stdout: 'pipe', stderr: 'ignore' });
    timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, LIVE_TIMEOUT_MS);
    const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`claude agents --json exited with ${code}.`);
    const listed = z.array(z.unknown()).safeParse(JSON.parse(output));
    if (!listed.success) throw new Error('claude agents --json answered in an unknown shape.');
    const sessions = listed.data.flatMap((entry) => {
      const live = LiveSessionSchema.safeParse(entry);
      return live.success ? [live.data] : [];
    });
    return Promise.all(
      sessions.map(async (live) => ({
        ...live,
        owner: await readClaudeSessionOwner(live, registrationsDir),
      }))
    );
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

export function claudeRemoteLink(record: ClaudeDesktopRecord): string | undefined {
  const bridge =
    record.remoteControlUserEnabled === false ? undefined : record.bridgeSessionIds?.at(-1);
  return bridge && /^session_[A-Za-z0-9]+$/.test(bridge)
    ? `https://claude.ai/code/${bridge}`
    : undefined;
}

function toClaudeWork(
  record: ClaudeDesktopRecord,
  live: ReadonlyMap<string, string>,
  machine: string
): WorkSummary {
  const folder = folderOf(record);
  const remoteLink = claudeRemoteLink(record);
  return {
    ref: { adapter: 'claude-desktop', id: record.sessionId },
    desktopUI: DESKTOP_UI_UNCONFIRMED,
    title: record.title,
    place: folder
      ? { machine, folder, name: basename(folder) || folder }
      : { machine, name: 'Chats' },
    status: claudeDesktopWorkStatus(record, live),
    lastActivityAt: record.lastActivityAt,
    ...(record.desktopRegistered
      ? {
          link: `claude://claude.ai/epitaxy/${record.sessionId}`,
          ...(record.permissionMode
            ? {
                permissionMode: record.permissionMode,
                watchHint: `Desktop permission mode: ${record.permissionMode}. Native tool approvals may be required.`,
              }
            : {}),
        }
      : {
          watchHint:
            'Watch this Claude Code session via Neo with work.status using this work ref. It is not registered in Claude Desktop yet.',
        }),
    ...(remoteLink ? { remoteLink } : {}),
    ...(record.desktopRegistered ? { remoteControl: !!remoteLink } : {}),
  };
}

export function matchClaudeSessions(
  chats: readonly WorkChatMatch[]
): ReadonlyMap<string, WorkChatMatch> {
  return matchChatsBy(chats, (chat) => (chat.kind === 'claude' ? chat.sessionId : null));
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
  return runLagPhase('scanner:claude_desktop', () =>
    readClaudeDesktopRecords(deps.sessionsDir, cache)
  );
}

export async function loadLiveClaudeSessions(
  deps: ClaudeDesktopAdapterDeps,
  records: readonly ClaudeDesktopRecord[]
): Promise<readonly ClaudeLiveSession[]> {
  if (!records.some((record) => !record.isArchived)) return [];
  return deps.liveSessions().catch((): readonly ClaudeLiveSession[] => []);
}

export async function probeLiveClaudeSessions(
  deps: Pick<ClaudeDesktopAdapterDeps, 'liveSessions'>
): Promise<Gate<readonly ClaudeLiveSession[]>> {
  try {
    return { value: await deps.liveSessions() };
  } catch (error) {
    return {
      reason: reject(
        'not_delivered',
        `Could not inspect live Claude sessions: ${error instanceof Error ? error.message : String(error)}`
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
  record: ClaudeTranscriptLocation
): string | null {
  const cwd = record.cwd ?? record.originCwd;
  if (!cwd || !record.cliSessionId) return null;
  return join(projectsDir, cwd.replace(/[/.]/g, '-'), `${record.cliSessionId}.jsonl`);
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

export interface ClaudeTranscriptState {
  turnEnds?: WorkDetail['turnEnds'];
  reply: string | null;
  replyAt?: number;
  inputs: WorkInput[];
  lastAt: number;
  exchange?: WorkExchange;
  openedPrs?: string[];
}

interface ClaudeTranscriptEntry {
  uuid?: unknown;
  type?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  isMeta?: unknown;
  turnOrigin?: unknown;
  origin?: unknown;
  attachment?: unknown;
  message?: { content?: unknown };
}

function queuedPeerText(entry: ClaudeTranscriptEntry): string | null {
  const attachment = entry.attachment as
    | { type?: unknown; origin?: { kind?: unknown; body?: unknown } }
    | undefined;
  if (entry.type !== 'attachment' || attachment?.type !== 'queued_command') return null;
  if (attachment.origin?.kind !== 'peer') return null;
  return typeof attachment.origin.body === 'string' ? attachment.origin.body : null;
}

function claudeInputText(entry: ClaudeTranscriptEntry): string | null {
  if (entry.type === 'attachment') return queuedPeerText(entry);
  if (entry.type !== 'user' || (entry.isMeta && !entry.turnOrigin && !entry.origin)) return null;
  const body = (entry.origin as { body?: unknown } | undefined)?.body;
  if (typeof body === 'string') return body;
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((part: { type?: unknown }) => part?.type === 'tool_result')) return null;
  return content
    .flatMap((part: { type?: unknown; text?: unknown }) =>
      part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    )
    .join('\n');
}

export function claudeTranscriptState(
  lines: readonly string[],
  since?: number,
  truncated = false
): ClaudeTranscriptState {
  const turnEnds: NonNullable<WorkDetail['turnEnds']> = [];
  const inputs: WorkInput[] = [];
  const exchange: WorkExchangeEntry[] = [];
  let turn: string[] = [];
  let ended = true;
  let fresh = false;
  let replyAt: number | undefined;
  let lastAt = 0;
  let earliest: number | undefined;
  let startedAt: number | undefined;
  for (const line of lines) {
    let entry: ClaudeTranscriptEntry | null;
    try {
      entry = JSON.parse(line) as ClaudeTranscriptEntry | null;
    } catch {
      continue;
    }
    if (!entry) continue;
    const at = workEntryTime(entry.timestamp);
    if (at !== undefined) lastAt = Math.max(lastAt, at);
    earliest ??= at;
    if (entry.type === 'user' && entry.isSidechain !== true && ended) startedAt = at;
    const said = assistantText(line);
    if (said && entry.isSidechain !== true) {
      turn = fresh ? [said] : [...turn, said];
      fresh = false;
      replyAt = at;
    }
    if (
      entry.type === 'assistant' &&
      entry.isSidechain !== true &&
      claudeTurnEnded(entry) &&
      at !== undefined &&
      at > (since ?? -Infinity)
    ) {
      const content = entry.message?.content;
      turnEnds.push({
        id: typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : String(at),
        at,
        startedAt,
        message: Array.isArray(content)
          ? content
              .flatMap((part: { type?: unknown; text?: unknown }) =>
                part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []
              )
              .join('\n')
          : '',
      });
      startedAt = undefined;
    }
    if (entry.type === 'assistant' && entry.isSidechain !== true) ended = claudeTurnEnded(entry);
    const text = claudeInputText(entry);
    if (text !== null && ended) fresh = true;
    const input =
      text === null
        ? null
        : workInput(
            at,
            text,
            entry.type === 'user' &&
              !entry.isMeta &&
              !entry.origin &&
              (!entry.turnOrigin || entry.turnOrigin === 'human' || entry.turnOrigin === 'user')
          );
    if (input) inputs.push(input);
    const next =
      since === undefined
        ? null
        : said
          ? exchangeEntry(at, 'agent', said, since)
          : text !== null
            ? exchangeEntry(at, 'user', text, since)
            : null;
    if (next) exchange.push(next);
  }
  const openedPrs = claudeOpenedPrs(lines);
  const reply = turnReply(turn);
  return {
    ...(turnEnds.length ? { turnEnds } : {}),
    reply,
    ...(reply !== null && replyAt !== undefined ? { replyAt } : {}),
    inputs: recentWorkInputs(inputs, since),
    lastAt,
    ...(since !== undefined
      ? {
          exchange: boundExchange(
            exchange,
            truncated && (earliest === undefined || earliest > since)
          ),
        }
      : {}),
    ...(openedPrs.length ? { openedPrs } : {}),
  };
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

export async function readClaudeTranscript(
  record: ClaudeTranscriptLocation,
  deps: Pick<ClaudeDesktopAdapterDeps, 'projectsDir'>,
  since?: number
): Promise<ClaudeTranscriptState | null> {
  const path = claudeTranscriptPath(deps.projectsDir, record);
  if (!path) return null;
  try {
    const { lines, truncated } = await readTailLines(path, TRANSCRIPT_TAIL_BYTES);
    return claudeTranscriptState(lines, since, truncated);
  } catch {
    return null;
  }
}

export function describeClaudeSession(
  record: ClaudeDesktopRecord,
  liveSessions: readonly ClaudeLiveSession[],
  transcript: ClaudeTranscriptState | null,
  deps: ClaudeDesktopAdapterDeps
): Result<WorkDetail> {
  const live = new Map(liveSessions.map((session) => [session.sessionId, session.status]));
  const waitingFor = liveSessions.find(
    (session) => session.sessionId === record.cliSessionId && session.status === 'waiting'
  )?.waitingFor;
  const work = {
    ...toClaudeWork(record, live, deps.machine),
    ...workExecutionLocation(record.cwd, deps.machine),
    ...(waitingFor ? { waitingFor } : {}),
  };
  if (!transcript) return { ok: true, value: { ...work, ...claudeSessionLinks(record) } };
  return {
    ok: true,
    value: {
      ...work,
      lastActivityAt: Math.max(work.lastActivityAt, transcript.lastAt),
      ...(transcript.turnEnds?.length ? { turnEnds: transcript.turnEnds } : {}),
      ...(transcript.reply ? { lastReply: transcript.reply } : {}),
      ...(transcript.reply && transcript.replyAt !== undefined
        ? { lastReplyAt: transcript.replyAt }
        : {}),
      recentInputs: transcript.inputs,
      ...withExchange(transcript.exchange),
      ...(transcript.openedPrs ? { openedPrs: transcript.openedPrs } : {}),
      ...claudeSessionLinks(record),
    },
  };
}

export function claudeSessionLinks(
  record: Pick<ClaudeDesktopRecord, 'prs' | 'branch' | 'writtenBranches'>
): {
  linkedPrs?: { url: string; dismissed?: true; own?: true }[];
  linkedPrsWindow?: true;
  branches?: string[];
} {
  const branches = [
    ...new Set([
      ...(record.writtenBranches ?? []).map((entry) => entry.split('\u0000').at(-1) ?? ''),
      ...(record.branch ? [record.branch] : []),
    ]),
  ].filter(Boolean);
  return {
    ...(record.prs
      ? {
          linkedPrs: record.prs.map((pr) => ({
            url: pr.url,
            ...(pr.dismissed ? { dismissed: true as const } : {}),
            ...(pr.own ? { own: true as const } : {}),
          })),
          linkedPrsWindow: true as const,
        }
      : {}),
    ...(branches.length ? { branches } : {}),
  };
}

const runClaudeDesktopStatus = (superpipe({})('claude-desktop-work-status') as PipelineAPI)
  .input(['ref', 'deps', 'cache', 'since', 'receipt'])
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(requireClaudeRecord, ['ref', 'records'], 'result:outcome')
  .pipe((record: ClaudeDesktopRecord) => record, 'outcome', 'record')
  .pipe(loadLiveClaudeSessions, ['deps', 'records'], 'liveSessions')
  .pipe(readClaudeTranscript, ['record', 'deps', 'since'], 'transcript')
  .pipe(readClaudeInputEvidence, ['record', 'deps', 'receipt'], 'evidence')
  .pipe(describeClaudeSession, ['record', 'liveSessions', 'transcript', 'deps'], 'outcome')
  .pipe(withClaudeInputEvidence, ['outcome', 'evidence'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache,
  since: number | undefined,
  receipt: ClaudeReceipt | undefined
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

export function claudeRelayPrompt(name: string, message: string): string {
  return fillPrompt(CLAUDE_DESKTOP_RELAY, { name: JSON.stringify(name), message });
}

type ClaudeReceipt = NonNullable<WorkDelivery['receipt']>;
type ClaudeInputEvidence = NonNullable<WorkDetail['inputEvidence']>;

const messageOpening = (message: string) =>
  JSON.stringify(Array.from(message.trim().split('\n')[0]).slice(0, 200).join('')).slice(1, -1);

function parseClaudeEntry(line: string): (ClaudeTranscriptEntry & { uuid?: unknown }) | null {
  try {
    const entry = JSON.parse(line) as (ClaudeTranscriptEntry & { uuid?: unknown }) | null;
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    return null;
  }
}

type ClaudeConfirmed = { inputId: string | null; at: number | undefined };

export function claudeDirectInput(
  lines: readonly string[],
  inputId: string,
  message: string
): ClaudeConfirmed | undefined {
  const opening = messageOpening(claudeInboxText(message));
  const entry = lines
    .map((line) => ({ line, entry: parseClaudeEntry(line) }))
    .find(
      ({ line, entry }) =>
        entry?.uuid === inputId || (entry?.type === 'queue-operation' && line.includes(opening))
    )?.entry;
  return entry ? { inputId, at: workEntryTime(entry.timestamp) } : undefined;
}

export function claudeTurnInput(
  lines: readonly string[],
  message: string
): ClaudeConfirmed | undefined {
  const opening = messageOpening(message);
  const entry = lines
    .filter((line) => line.includes(opening))
    .map(parseClaudeEntry)
    .find((candidate) => candidate?.type === 'user' && typeof candidate.uuid === 'string');
  return entry ? { inputId: entry.uuid as string, at: workEntryTime(entry.timestamp) } : undefined;
}

export function claudeRelayedInput(
  lines: readonly string[],
  message: string
): ClaudeConfirmed | undefined {
  const opening = messageOpening(message);
  const hits = lines
    .filter((line) => line.includes('cross-session-message') && line.includes(opening))
    .map(parseClaudeEntry);
  const input = hits.find((entry) => typeof entry?.uuid === 'string' && entry.uuid);
  const queued = hits.find((entry) => entry?.type === 'queue-operation');
  const found = input ?? queued;
  return found
    ? {
        inputId: input ? (input.uuid as string) : null,
        at: workEntryTime(found.timestamp),
      }
    : undefined;
}

function claudeTurnEnded(entry: ClaudeTranscriptEntry): boolean {
  const stop = (entry.message as { stop_reason?: unknown } | undefined)?.stop_reason;
  return typeof stop === 'string' && stop !== 'tool_use';
}

export function claudeInputEvidence(
  lines: readonly string[],
  receipt: ClaudeReceipt,
  cliSessionId: string | null | undefined
): ClaudeInputEvidence {
  const unavailable: ClaudeInputEvidence = { receipt, state: 'unavailable' };
  if (receipt.executionId !== cliSessionId) return unavailable;
  const start = lines.findIndex((line) => parseClaudeEntry(line)?.uuid === receipt.inputId);
  const input = start < 0 ? null : parseClaudeEntry(lines[start]);
  const text = input ? claudeInputText(input) : null;
  const first =
    input && text !== null
      ? exchangeEntry(workEntryTime(input.timestamp), 'user', text || '[Non-text input]', -Infinity)
      : null;
  if (!first) return unavailable;
  const replies: WorkExchangeEntry[] = [];
  const window = lines.slice(start + 1).filter((line) => line.trim());
  let ended = false;
  let completed = false;
  for (const [index, line] of window.entries()) {
    const entry = parseClaudeEntry(line);
    if (!entry) {
      if (index === window.length - 1) break;
      return unavailable;
    }
    if (entry.isSidechain === true || entry.type === 'attachment') continue;
    if (claudeInputText(entry) !== null) {
      ended = true;
      break;
    }
    if (entry.type === 'assistant') {
      ended = claudeTurnEnded(entry);
      completed = ended;
    }
    const said = assistantText(line);
    const reply = said
      ? exchangeEntry(workEntryTime(entry.timestamp), 'agent', said, -Infinity)
      : null;
    if (reply) replies.push(reply);
  }
  if (!ended) return { receipt, state: 'pending', transcriptState: 'accepted' };
  return {
    receipt,
    state: 'observed',
    transcriptState: completed ? 'completed' : 'accepted',
    exchange: [first, ...turnReplies(replies)],
    exchangeCut: replies.length > TURN_REPLIES,
  };
}

export async function readClaudeInputEvidence(
  record: ClaudeTranscriptLocation,
  deps: Pick<ClaudeDesktopAdapterDeps, 'projectsDir'>,
  receipt: ClaudeReceipt | undefined
): Promise<ClaudeInputEvidence | null> {
  if (!receipt) return null;
  const path = claudeTranscriptPath(deps.projectsDir, record);
  if (!path) return { receipt, state: 'unavailable' };
  try {
    const pending = /^desktop-pending:(\d+):([a-f0-9]{64})$/.exec(receipt.inputId);
    if (pending && receipt.executionId === record.cliSessionId) {
      const lines = await readLinesAfter(path, Number(pending[1]), true);
      const input = lines.map(parseClaudeEntry).find((entry) => {
        const text = entry?.type === 'user' ? claudeInputText(entry) : null;
        const native =
          text &&
          /<cross-session-message from="([^"]+)"[^>]*>\n([\s\S]*)\n<\/cross-session-message>$/.exec(
            text
          );
        return (
          typeof entry?.uuid === 'string' &&
          native &&
          nativeInputFingerprint(native[1], native[2]) === pending[2]
        );
      });
      if (!input) return { receipt, state: 'pending' };
      const evidence = claudeInputEvidence(
        lines,
        { ...receipt, inputId: input.uuid as string },
        record.cliSessionId
      );
      return { ...evidence, receipt };
    }
    const { lines } = await readTailLines(path, TRANSCRIPT_TAIL_BYTES);
    return claudeInputEvidence(lines, receipt, record.cliSessionId);
  } catch {
    return { receipt, state: 'unavailable' };
  }
}

export function withClaudeInputEvidence(
  outcome: Result<WorkDetail>,
  evidence: ClaudeInputEvidence | null
): Result<WorkDetail> {
  return outcome.ok && evidence
    ? { ok: true, value: { ...outcome.value, inputEvidence: evidence } }
    : outcome;
}

const CLAUDE_LOGIN_FAILURE =
  /OAuth session expired|Failed to authenticate|not logged in|Please run \/login|Invalid API key/i;

export function claudeCliFailure(output: { stdout?: string; stderr?: string }, fallback: string) {
  const text = [output.stderr, output.stdout]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n');
  if (CLAUDE_LOGIN_FAILURE.test(text)) {
    const said = text.split('\n').find((line) => CLAUDE_LOGIN_FAILURE.test(line)) ?? text;
    return reject(
      'claude_cli_login_expired',
      `The claude CLI on this Mac is not logged in (${said.trim()}). Run \`claude auth login\`, then try again.`
    );
  }
  return reject('not_delivered', text || fallback);
}

async function locateClaudeTranscript(
  projectsDir: string,
  record: ClaudeTranscriptLocation
): Promise<string | null> {
  const known = claudeTranscriptPath(projectsDir, record);
  if (known || !record.cliSessionId) return known;
  for (const folder of await listDir(projectsDir)) {
    const candidate = join(projectsDir, folder, `${record.cliSessionId}.jsonl`);
    if (await transcriptSize(candidate)) return candidate;
  }
  return null;
}

async function transcriptSize(path: string | null): Promise<number> {
  if (!path) return 0;
  return stat(path).then(
    (info) => info.size,
    () => 0
  );
}

async function readLinesAfter(
  path: string | null,
  offset: number,
  tail = false
): Promise<string[]> {
  if (!path) return [];
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.min(tail ? Math.max(offset, size - TRANSCRIPT_TAIL_BYTES) : offset, size);
    const buffer = Buffer.alloc(Math.min(size - start, TRANSCRIPT_TAIL_BYTES));
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return start > offset ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

async function awaitClaudeInput<T>(
  read: () => Promise<readonly string[]>,
  match: (lines: readonly string[]) => T | undefined,
  deps: Pick<ClaudeDesktopAdapterDeps, 'sleep'>
): Promise<T | undefined> {
  for (let poll = 1; ; poll++) {
    const found = match(await read().catch(() => []));
    if (found !== undefined || poll >= DELIVERY_POLLS) return found;
    await deps.sleep(DELIVERY_POLL_MS);
  }
}

async function relayClaudeMessage(
  record: ClaudeDesktopRecord & { cliSessionId: string },
  liveSessions: readonly ClaudeLiveSession[],
  message: string,
  path: string | null,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<ClaudeConfirmed>> {
  const name = liveSessions.find((session) => session.sessionId === record.cliSessionId)?.name;
  if (!name || liveSessions.filter((session) => session.name === name).length > 1)
    return reject('not_delivered', `${record.title} has no unique name to relay a message to.`);
  const before = await transcriptSize(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = deps.spawn(
      [
        'claude',
        '-p',
        '--model',
        'haiku',
        '--max-turns',
        '4',
        '--permission-mode',
        record.permissionMode ?? 'default',
        '--tools',
        'SendMessage ListAgents',
        '--allowedTools',
        'SendMessage ListAgents',
        '-n',
        'HyperNeo relay',
        claudeRelayPrompt(name, message),
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    timer = setTimeout(() => proc.kill('SIGKILL'), RELAY_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return claudeCliFailure({ stdout, stderr }, `The relay exited with ${code}.`);
    const confirmed = await awaitClaudeInput(
      () => readLinesAfter(path, before),
      (lines) => claudeRelayedInput(lines, message),
      deps
    );
    return confirmed
      ? { ok: true, value: confirmed }
      : reject('not_delivered', 'the relayed message did not appear either');
  } catch (error) {
    return reject('not_delivered', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

function nativeInputFingerprint(helperSessionId: string, message: string): string {
  return createHash('sha256')
    .update(JSON.stringify([helperSessionId, message]))
    .digest('hex');
}

export async function relayNativeDesktopMessage(
  target: ClaudeDesktopRecord & { cliSessionId: string },
  helper: ClaudeDesktopRecord & { cliSessionId: string },
  liveSessions: readonly ClaudeLiveSession[],
  message: string,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<WorkDelivery>> {
  const path = await locateClaudeTranscript(deps.projectsDir, target);
  const before = await transcriptSize(path);
  const relayed = await relayClaudeMessage(
    helper,
    liveSessions,
    fillPrompt(CLAUDE_DESKTOP_WAKE_REQUEST, {
      request: JSON.stringify({ session_id: target.sessionId, message }),
    }),
    await locateClaudeTranscript(deps.projectsDir, helper),
    deps
  );
  if (!relayed.ok) return relayed;
  const confirmed = await awaitClaudeInput(
    () => readLinesAfter(path, before),
    (lines) => claudeNativeInput(lines, helper.sessionId, message),
    deps
  );
  return confirmed
    ? {
        ok: true,
        value: {
          delivered: true,
          receipt: { executionId: target.cliSessionId, inputId: confirmed.inputId! },
          confirmedAt: confirmed.at ?? deps.now(),
        },
      }
    : {
        ok: true,
        value: {
          delivered: false,
          unconfirmed: true,
          receipt: {
            executionId: target.cliSessionId,
            inputId: `desktop-pending:${before}:${nativeInputFingerprint(helper.sessionId, message)}`,
          },
        },
      };
}

export function claudeNativeInput(
  lines: readonly string[],
  helperSessionId: string,
  message: string
): ClaudeConfirmed | undefined {
  for (const line of lines) {
    const entry = parseClaudeEntry(line);
    if (entry?.type !== 'user' || typeof entry.uuid !== 'string') continue;
    const content = entry.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((block) =>
                block && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
              )
              .join('\n')
          : '';
    if (
      text.includes(`<cross-session-message from="${helperSessionId}"`) &&
      text.endsWith(`>\n${message}\n</cross-session-message>`)
    )
      return { inputId: entry.uuid, at: workEntryTime(entry.timestamp) };
  }
  return undefined;
}

async function readCurrentDesktopReceiver(
  record: ClaudeDesktopRecord & { cliSessionId: string },
  deps: ClaudeDesktopAdapterDeps
) {
  return (await readClaudeDesktopRecords(deps.sessionsDir, new Map())).find(
    (candidate) =>
      candidate.sessionId === record.sessionId && candidate.cliSessionId === record.cliSessionId
  );
}

async function sendOwnedClaudeMessage(
  record: ClaudeDesktopRecord & { cliSessionId: string },
  liveSessions: readonly ClaudeLiveSession[],
  message: string,
  deps: ClaudeDesktopAdapterDeps,
  context?: WorkCallContext
): Promise<Result<WorkDelivery>> {
  const desktop = liveSessions.some(
    (session) => session.sessionId === record.cliSessionId && session.owner === 'desktop'
  );
  if (!desktop && !deps.sendInbox)
    return reject('unsupported', 'The direct Claude inbox transport is unavailable.');
  if (!desktop && !context)
    return reject('unsupported', 'The Claude inbox requires a session reply destination.');
  const path = await locateClaudeTranscript(deps.projectsDir, record);
  const before = await transcriptSize(path);
  const receiver = desktop ? await readCurrentDesktopReceiver(record, deps) : record;
  const direct =
    deps.sendInbox && context && receiver
      ? await deps
          .sendInbox(
            record.cliSessionId,
            message,
            context,
            desktop
              ? receiver.permissionMode === 'bypassPermissions'
                ? 'bypass'
                : 'prompting'
              : undefined
          )
          .catch((error: unknown) =>
            reject('not_delivered', error instanceof Error ? error.message : String(error))
          )
      : reject('unsupported', 'No direct inbox with a session reply destination.');
  const receipt = direct.ok ? direct.value.receipt : undefined;
  const confirmed =
    receipt &&
    (await awaitClaudeInput(
      () => readLinesAfter(path, before),
      (lines) => claudeDirectInput(lines, receipt.inputId, message),
      deps
    ));
  if (confirmed)
    return {
      ok: true,
      value: { delivered: true, receipt, confirmedAt: confirmed.at ?? deps.now() },
    };
  if (receipt && !desktop)
    return { ok: true, value: { delivered: false, unconfirmed: true, receipt } };
  const current = desktop ? await readCurrentDesktopReceiver(record, deps) : record;
  if (!current)
    return reject(
      'not_delivered',
      `${record.title}: receiver mode unknown; current Desktop metadata is unavailable, so no relay was sent.`
    );
  const receiverMode =
    (desktop
      ? await readClaudeReceiverMode(
          record.cliSessionId,
          deps.liveSessions,
          deps.listProcesses ?? listProcesses
        )
      : null) ??
    current.permissionMode ??
    'default';
  const relayRecord = desktop
    ? {
        ...record,
        permissionMode: receiverMode === 'bypassPermissions' ? 'bypassPermissions' : 'auto',
      }
    : record;
  const relayed = await relayClaudeMessage(relayRecord, liveSessions, message, path, deps);
  if (relayed.ok)
    return {
      ok: true,
      value: {
        delivered: true,
        ...(relayed.value.inputId
          ? { receipt: { executionId: record.cliSessionId, inputId: relayed.value.inputId } }
          : {}),
        confirmedAt: relayed.value.at ?? deps.now(),
      },
    };
  return reject(
    relayed.reason === 'claude_cli_login_expired' ? relayed.reason : 'not_delivered',
    `${record.title} did not receive the message${desktop ? ` (receiver mode: ${receiverMode})` : ''}: the direct inbox message failed (${direct.ok ? (receipt ? 'not confirmed in receiver transcript' : 'no receipt') : direct.detail}); the relay failed: ${relayed.detail}`
  );
}

const HEADLESS_PERMISSION_MODES = new Set(['bypassPermissions', 'auto']);

export function claudeHeadlessStartMode(lines: readonly string[]): string | null {
  for (const line of lines) {
    const row = (() => {
      try {
        return JSON.parse(line) as { type?: string; entrypoint?: string; permissionMode?: string };
      } catch {
        return null;
      }
    })();
    if (row?.type !== 'user') continue;
    return row.entrypoint === 'sdk-cli' &&
      row.permissionMode &&
      HEADLESS_PERMISSION_MODES.has(row.permissionMode)
      ? row.permissionMode
      : null;
  }
  return null;
}

async function readHeadLines(path: string | null): Promise<string[]> {
  if (!path) return [];
  const file = await open(path, 'r').catch(() => null);
  if (!file) return [];
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(65_536), 0, 65_536, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, -1);
  } finally {
    await file.close();
  }
}

export async function resumeIdleClaudeSession(
  record: ClaudeDesktopRecord & { cliSessionId: string },
  liveSessions: readonly ClaudeLiveSession[],
  message: string,
  deps: ClaudeDesktopAdapterDeps
): Promise<{ value: readonly ClaudeLiveSession[] } | { reason: Result<WorkDelivery> }> {
  const running = (sessions: readonly ClaudeLiveSession[]) =>
    sessions.some((session) => session.sessionId === record.cliSessionId && session.pid);
  const folder = record.cwd ?? record.originCwd ?? deps.homeDir;
  const sandbox = await readClaudeWorkerSandbox(folder);
  if (running(liveSessions)) return { value: liveSessions };
  if (!deps.folderExists(folder))
    return {
      reason: reject(
        'unreachable',
        `${record.title} is not open in Claude Desktop, and its folder ${folder} no longer exists, so it cannot be reopened.`
      ),
    };
  const path = await locateClaudeTranscript(deps.projectsDir, record);
  const mode = record.desktopRegistered
    ? 'auto'
    : record.permissionMode && HEADLESS_PERMISSION_MODES.has(record.permissionMode)
      ? record.permissionMode
      : claudeHeadlessStartMode(await readHeadLines(path));
  if (!mode)
    return {
      reason: reject(
        'unreachable',
        `${record.title} is not running, and in ${record.permissionMode ?? 'default'} permission mode a headless turn cannot get tool approvals. Open it in Claude Desktop: claude://claude.ai/epitaxy/${record.sessionId}`
      ),
    };
  const recheck = await deps.liveSessions().catch(() => liveSessions);
  if (running(recheck)) return { value: recheck };
  const turn = await runClaudeTurn(
    [
      'claude',
      '-p',
      '--resume',
      record.cliSessionId,
      '--permission-mode',
      mode,
      ...(sandbox ? ['--settings', join(folder, '.claude/settings.local.json')] : []),
      '--',
      message,
    ],
    folder,
    record,
    message,
    deps,
    DELIVERY_POLLS
  );
  if (!turn.ok && record.desktopRegistered) {
    const current = (await readClaudeDesktopRecords(deps.sessionsDir, new Map())).find(
      (candidate) => candidate.sessionId === record.sessionId
    );
    return {
      reason: reject(
        turn.reason,
        `${record.title} (receiver mode: ${current?.permissionMode ?? 'unknown'}): auto headless turn failed: ${turn.detail} Desktop warm spawn was not attempted because its process cap can refuse stopped sessions.`
      ),
    };
  }
  return {
    reason: turn.ok
      ? {
          ok: true,
          value: {
            delivered: true,
            receipt: {
              executionId: record.cliSessionId,
              inputId: turn.value.inputId ?? record.cliSessionId,
            },
            confirmedAt: turn.value.at ?? deps.now(),
          },
        }
      : turn,
  };
}

export const sendClaudeMessage = (superpipe({})('claude-owner-send') as PipelineAPI)
  .input(['record', 'liveSessions', 'message', 'deps', 'context'])
  .pipe(
    (record: ClaudeDesktopRecord & { cliSessionId: string }) => record.cliSessionId,
    'record',
    'cliSessionId'
  )
  .pipe(resumeIdleClaudeSession, ['record', 'liveSessions', 'message', 'deps'], 'result:outcome')
  .pipe((live: readonly ClaudeLiveSession[]) => live, 'outcome', 'running')
  .pipe(requireClaudePeerOwner, ['cliSessionId', 'running'], 'result:outcome')
  .pipe(sendOwnedClaudeMessage, ['record', 'running', 'message', 'deps', 'context'], 'outcome')
  .endAsync('outcome') as (
  record: ClaudeDesktopRecord & { cliSessionId: string },
  liveSessions: readonly ClaudeLiveSession[],
  message: string,
  deps: ClaudeDesktopAdapterDeps,
  context?: WorkCallContext
) => Promise<Result<WorkDelivery>>;

export async function withRemoteControl(
  sent: Result<WorkDelivery>,
  record: ClaudeDesktopRecord,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<WorkDelivery>> {
  if (!sent.ok) return sent;
  const fresh = (await readClaudeDesktopRecords(deps.sessionsDir, new Map())).find(
    (candidate) => candidate.sessionId === record.sessionId
  );
  return {
    ok: true,
    value: {
      ...sent.value,
      desktopUI: DESKTOP_UI_UNCONFIRMED,
      remoteControl: !!claudeRemoteLink(fresh ?? record),
    },
  };
}

const runClaudeDesktopSend = (superpipe({})('claude-desktop-send-work') as PipelineAPI)
  .input(['ref', 'message', 'deps', 'cache', 'context'])
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(requireClaudeRecord, ['ref', 'records'], 'result:outcome')
  .pipe(requireOpenClaudeRecord, 'outcome', 'result:outcome')
  .pipe((record: ClaudeDesktopRecord) => record, 'outcome', 'record')
  .pipe(probeLiveClaudeSessions, 'deps', 'result:outcome')
  .pipe((live: readonly ClaudeLiveSession[]) => live, 'outcome', 'liveSessions')
  .pipe(sendClaudeMessage, ['record', 'liveSessions', 'message', 'deps', 'context'], 'outcome')
  .pipe(withRemoteControl, ['outcome', 'record', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache,
  context?: WorkCallContext
) => Promise<Result<WorkDelivery>>;

type ModsAction = { kind: 'queue' | 'withdraw'; value: string } | { kind: 'stop' };
async function invokeDesktopMods(
  record: ClaudeDesktopRecord & { cliSessionId: string },
  action: ModsAction,
  context: WorkCallContext,
  deps: ClaudeDesktopAdapterDeps
) {
  const mods = await deps.mods;
  if (!mods)
    return reject(
      'unsupported',
      'The configured Desktop mods bridge is unavailable; inspect daemon logs.'
    );
  return action.kind === 'stop'
    ? mods.stop(record.cliSessionId, context)
    : action.kind === 'queue'
      ? mods.queue(record.cliSessionId, action.value, context)
      : mods.withdraw(record.cliSessionId, action.value, context);
}
const runClaudeDesktopMods = (superpipe({})('claude-desktop-mods-work') as PipelineAPI)
  .input(['ref', 'action', 'context', 'deps', 'cache'])
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(requireClaudeRecord, ['ref', 'records'], 'result:outcome')
  .pipe(requireOpenClaudeRecord, 'outcome', 'result:outcome')
  .pipe(invokeDesktopMods, ['outcome', 'action', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  action: ModsAction,
  context: WorkCallContext,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache
) => Promise<Result<WorkDelivery | WorkWithdrawal | { stopped: boolean }>>;

function admitClaudeStartConfiguration(request: StartRequest): Gate<StartRequest> {
  const field =
    request.model !== undefined ? 'model' : request.effort !== undefined ? 'effort' : null;
  return field
    ? {
        reason: reject(
          field === 'model' ? 'unsupported_model' : 'unsupported_effort',
          `Claude desktop cannot confirm the requested ${field}. Choose an adapter that supports it.`
        ),
      }
    : { value: request };
}

export function selectClaudeStartFolder(
  request: StartRequest,
  deps: ClaudeDesktopAdapterDeps
): Gate<string> {
  const admitted = workStartPreparation.admit(request.preparation, !!deps.prepareExecution);
  if ('reason' in admitted) return admitted;
  return selectLocalStartFolder(request, deps, 'A Claude Code session needs a folder to work in.');
}

export async function runToExit(
  deps: ClaudeDesktopAdapterDeps,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = deps.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
    timer = setTimeout(() => proc.kill('SIGKILL'), BOOTSTRAP_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

export async function launchInClaudeDesktop(
  cliSessionId: string,
  cwd: string,
  deps: Pick<ClaudeDesktopAdapterDeps, 'spawn'>
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sandbox = await readClaudeWorkerSandbox(cwd);
  try {
    const proc = deps.spawn(
      [
        'script',
        '-q',
        '/dev/null',
        'claude',
        '--desktop',
        '--resume',
        cliSessionId,
        ...(sandbox ? ['--settings', join(cwd, '.claude/settings.local.json')] : []),
      ],
      {
        cwd,
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      }
    );
    return await Promise.race([
      proc.exited.catch(() => -1),
      new Promise<number>((resolve) => {
        timer = setTimeout(async () => {
          try {
            if (proc.pid) {
              const owned = collectDescendantPids(
                await listProcesses().catch(() => []),
                new Set([proc.pid])
              );
              for (const pid of [...owned].reverse()) {
                try {
                  process.kill(pid, 'SIGKILL');
                } catch {}
              }
            }
          } finally {
            try {
              proc.kill('SIGKILL');
            } catch {}
            resolve(-1);
          }
        }, BOOTSTRAP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function importClaudeDesktopSession(
  cliSessionId: string,
  cwd: string,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<ClaudeDesktopRecord & { cliSessionId: string }>> {
  if ((await launchInClaudeDesktop(cliSessionId, cwd, deps)) !== 0)
    return reject('not_delivered', `Desktop handoff failed for local_${cliSessionId}.`);
  for (let poll = 0; poll < OPEN_WAIT_MS / OPEN_POLL_MS; poll++) {
    const record = (await readClaudeDesktopRecords(deps.sessionsDir, new Map())).find(
      (candidate) => candidate.cliSessionId === cliSessionId
    );
    if (record) return { ok: true, value: { ...record, cliSessionId } };
    await deps.sleep(OPEN_POLL_MS);
  }
  return reject(
    'not_delivered',
    `Desktop did not register local_${cliSessionId}; no task was dispatched.`
  );
}

export async function waitUntilLive(
  cliSessionId: string,
  deps: ClaudeDesktopAdapterDeps
): Promise<readonly ClaudeLiveSession[] | null> {
  const until = deps.now() + OPEN_WAIT_MS;
  while (deps.now() < until) {
    const live = await deps.liveSessions().catch((): readonly ClaudeLiveSession[] => []);
    if (
      live.some(
        (candidate) => candidate.sessionId === cliSessionId && candidate.name && candidate.pid
      )
    ) {
      return live;
    }
    await deps.sleep(OPEN_POLL_MS);
  }
  return null;
}

async function runClaudeTurn(
  args: string[],
  directory: string,
  location: ClaudeTranscriptLocation,
  message: string,
  deps: ClaudeDesktopAdapterDeps,
  polls: number,
  afterTurn?: () => void
): Promise<Result<ClaudeConfirmed>> {
  const before = await transcriptSize(await locateClaudeTranscript(deps.projectsDir, location));
  let exit: number | undefined;
  let confirmed = false;
  let proc: ReturnType<SpawnFn>;
  let stderr: Promise<string>;
  try {
    proc = deps.spawn(args, { cwd: directory, stdout: 'ignore', stderr: 'pipe' });
    stderr = new Response(proc.stderr).text().catch(() => '');
    const exited = (code: number) => {
      exit = code;
      if (confirmed) afterTurn?.();
    };
    proc.exited.then(exited, () => exited(-1));
  } catch (error) {
    return reject('not_delivered', error instanceof Error ? error.message : String(error));
  }
  for (let poll = 1; ; poll++) {
    const path = await locateClaudeTranscript(deps.projectsDir, location);
    const found = claudeTurnInput(await readLinesAfter(path, before).catch(() => []), message);
    if (found) {
      confirmed = true;
      if (exit !== undefined) afterTurn?.();
      return { ok: true, value: found };
    }
    if (exit !== undefined && exit !== 0)
      return claudeCliFailure({ stderr: await stderr }, `claude -p exited with ${exit}.`);
    if (poll >= polls) {
      proc.kill('SIGKILL');
      return reject('not_delivered', 'the message did not appear in the session transcript');
    }
    await deps.sleep(DELIVERY_POLL_MS);
  }
}

export async function startClaudeSession(
  folder: string,
  request: StartRequest,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache
): Promise<Result<WorkStarted>> {
  const cliSessionId = deps.newId();
  const sessionId = `local_${cliSessionId}`;
  const prepared = request.preparation
    ? await deps.prepareExecution!(request.preparation, {
        directory: folder,
        destination: join(getDataDir(), 'claude-worktrees', basename(folder), cliSessionId),
      })
    : null;
  if (prepared && !prepared.ok) return prepared;
  const sandboxed = !!prepared && workerSandboxOn();
  if (prepared && sandboxed) {
    try {
      const checkout = await deps.gitCheckout(folder);
      await installClaudeNativeWrites(prepared.value.directory, [folder, checkout?.repo ?? folder]);
    } catch (error) {
      await prepared.value.release();
      await releaseWorkerSandbox(prepared.value.directory);
      return reject(
        'preparation_failed',
        `Could not install native write policy: ${String(error)}`
      );
    }
  }
  const placement = planWorkPlacement(
    prepared || request.inPlace ? null : await deps.gitCheckout(folder).catch(() => null)
  );
  const worktree = placement.kind === 'worktree' ? `neo-${cliSessionId.slice(0, 8)}` : null;
  const permissionMode = deps.permissionMode?.() ?? 'auto';
  const cwd =
    placement.kind === 'worktree' && worktree
      ? join(placement.repo, '.claude', 'worktrees', worktree)
      : (prepared?.value.directory ?? folder);
  const opened = await runToExit(
    deps,
    [
      'claude',
      '-p',
      '--session-id',
      cliSessionId,
      '-n',
      request.title,
      '--permission-mode',
      permissionMode,
      '--max-turns',
      '1',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      ...(worktree ? ['--worktree', worktree] : []),
      ...(sandboxed ? ['--settings', join(cwd, '.claude/settings.local.json')] : []),
      '--',
      CLAUDE_DESKTOP_PREPARE,
    ],
    prepared?.value.directory ?? folder
  ).catch((error: unknown) => ({ code: -1, stdout: '', stderr: String(error) }));
  const location = { cliSessionId, cwd, originCwd: folder };
  const started =
    opened.code !== 0
      ? claudeCliFailure(opened, `Claude preparation exited with ${opened.code}.`)
      : claudeTurnInput(
            await readLinesAfter(await locateClaudeTranscript(deps.projectsDir, location), 0).catch(
              () => []
            ),
            CLAUDE_DESKTOP_PREPARE
          )
        ? { ok: true as const }
        : reject('not_delivered', 'the message did not appear in the session transcript');
  if (!started.ok) {
    await prepared?.value.release();
    if (prepared) await releaseWorkerSandbox(prepared.value.directory);
    return started;
  }
  const record: ClaudeDesktopRecord = {
    sessionId,
    cliSessionId,
    cwd,
    title: request.title,
    isArchived: false,
    lastActivityAt: deps.now(),
    permissionMode,
  };
  cache.set(`${STARTED_KEY}${sessionId}`, { modifiedAt: 0, records: [record] });
  const imported = await importClaudeDesktopSession(cliSessionId, cwd, deps);
  if (!imported.ok)
    return {
      ...imported,
      detail: `${imported.detail} Prepared session ${sessionId} and its execution directory are retained at ${cwd} for handoff recovery.`,
    };
  return {
    ok: true,
    value: {
      ...toClaudeWork(imported.value, new Map(), deps.machine),
      place: { machine: deps.machine, folder, name: request.place.name },
      status: 'queued',
    },
  };
}

const runClaudeDesktopStart = (superpipe({})('claude-desktop-start-work') as PipelineAPI)
  .input(['request', 'deps', 'cache', 'context'])
  .pipe(admitClaudeStartConfiguration, 'request', 'result:outcome')
  .pipe(selectClaudeStartFolder, ['outcome', 'deps'], 'result:outcome')
  .pipe(startClaudeSession, ['outcome', 'request', 'deps', 'cache'], 'outcome')
  .endAsync('outcome') as (
  request: StartRequest,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache,
  context: WorkCallContext
) => Promise<Result<WorkStarted>>;

export function createClaudeDesktopAdapter(deps: ClaudeDesktopAdapterDeps): WorkAdapter {
  const cache: ClaudeRecordCache = new Map();
  const reused = { ...deps, liveSessions: reuseLiveSessions(deps.liveSessions, Date.now) };
  return {
    id: 'claude-desktop',
    supportsStartPreparation: !!deps.prepareExecution,
    capabilities: [
      'find',
      'start',
      'send',
      'steer',
      'status',
      'archive',
      ...(deps.mods ? (['queue', 'stop', 'withdraw'] as const) : []),
    ],
    ...(deps.mods
      ? {
          queue: (ref: WorkRef, text: string, context: WorkCallContext) =>
            runClaudeDesktopMods(
              ref,
              { kind: 'queue', value: text },
              context,
              deps,
              cache
            ) as Promise<Result<WorkDelivery>>,
          stop: (ref: WorkRef, context: WorkCallContext) =>
            runClaudeDesktopMods(ref, { kind: 'stop' }, context, deps, cache) as Promise<
              Result<{ stopped: boolean }>
            >,
          withdraw: (ref: WorkRef, id: string, context: WorkCallContext) =>
            runClaudeDesktopMods(
              ref,
              { kind: 'withdraw', value: id },
              context,
              deps,
              cache
            ) as Promise<Result<WorkWithdrawal>>,
        }
      : {}),
    find: async (query) =>
      runClaudeDesktopFind(
        query,
        reused,
        cache,
        query.text && !query.spaceId && deps.searchChats ? await deps.searchChats(query.text) : []
      ),
    start: (request, context) => runClaudeDesktopStart(request, deps, cache, context),
    send: (ref, message, context) => runClaudeDesktopSend(ref, message, deps, cache, context),
    steer: (ref, message, context) => runClaudeDesktopSend(ref, message, deps, cache, context),
    status: (ref, since, receipt) => runClaudeDesktopStatus(ref, deps, cache, since, receipt),
    archive: (ref, admit) => archiveClaudeSession(ref, admit, deps),
  };
}

async function archiveClaudeSession(
  ref: WorkRef,
  admit: ArchiveAdmission,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<{ archived: boolean }>> {
  const records: ClaudeRecordCache = new Map();
  await readClaudeDesktopRecords(deps.sessionsDir, records);
  const paths = [...records].filter(([, entry]) =>
    entry.records.some((record) => record.sessionId === ref.id)
  );
  if (paths.length !== 1) return reject('not_found', 'Expected exactly one Claude session record.');
  const live = await deps.liveSessions();
  const path = paths[0][0];
  const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const record = RecordSchema.parse(original);
  if (record.sessionId !== ref.id) return reject('not_found', 'The Claude session changed.');
  if (
    record.cliSessionId &&
    live.some(
      (session) =>
        session.sessionId === record.cliSessionId &&
        !['idle', 'done', 'completed'].includes(session.status)
    )
  )
    return reject('busy', 'The Claude session still has a live turn.');
  const refused = admit();
  if (refused) return refused;
  await releaseWorkerSandbox(record.cwd);
  if (record.isArchived) return { ok: true, value: { archived: false } };
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...original, isArchived: true }), {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { ok: true, value: { archived: true } };
}
