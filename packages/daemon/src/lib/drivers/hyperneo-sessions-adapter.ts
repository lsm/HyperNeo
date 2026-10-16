import { workStartPreparation, type WorkExecutionPreparer } from './start-preparation.ts';
import { basename, join, sep } from 'node:path';
import type { WorkspaceHistoryEntry } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import type { MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import { sessionUnavailable } from '../session-resolution/session-lookup.ts';
import { ModelUnavailableError } from '../session/session-lifecycle.ts';
import { matchChatsBy } from './match-chats.ts';
import { withChatEvidence } from './places.ts';
import { selectLocalStartFolder } from './start-folder.ts';
import { workStartConfiguration } from './start-configuration.ts';
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
  WorkInput,
  WorkRef,
  WorkStarted,
  WorkStatus,
  WorkSummary,
} from './types.ts';
import { readSessionInputEvidence } from './space-input-evidence.ts';
import {
  boundExchange,
  exchangeEntry,
  recentWorkInputs,
  withExchange,
  workEntryTime,
  workInput,
} from './work-messages.ts';
import { reject } from './work-operations.ts';

const OPEN = `status IN ('active', 'paused', 'pending_worktree_choice')`;
const OWN_SESSIONS = `space_id IS NULL AND room_id IS NULL AND id NOT LIKE 'neo:%' AND type IN ('worker', 'general')`;
const FOLDER = 'COALESCE(main_repo_path, workspace_path)';
const PROCESSING = `CASE WHEN json_valid(processing_state) THEN CASE
  WHEN json_extract(processing_state, '$.status') = 'interrupted'
    AND json_extract(processing_state, '$.reason') = 'restart' THEN 'interrupted_by_restart'
  ELSE json_extract(processing_state, '$.status') END END`;
const SESSION_COLUMNS = `id, title, status, ${FOLDER} AS folder, last_active_at AS lastActiveAt,
  ${PROCESSING} AS processing`;
const SESSIONS_PER_PLACE = 20;
const CLOSED_SESSIONS = 500;
const REPLY_LIMIT = 4_000;
const TAIL_INPUTS = 8;
const INPUTS_AFTER = 50;
const LANDED_INPUT = `message_type = 'user' AND parent_tool_use_id IS NULL
  AND COALESCE(send_status, 'consumed') = 'consumed'
  AND COALESCE(json_extract(sdk_message, '$.inputKind'), '') <> 'system'
  AND COALESCE(json_extract(sdk_message, '$.message.content[0].type'), 'text') = 'text'`;

export interface HyperNeoSessionsPlaceRow {
  folder: string | null;
  openCount: number;
  archivedCount: number;
  known: number;
  lastActiveAt: string | null;
}

export interface HyperNeoSessionsRow {
  id: string;
  title: string;
  status: string;
  folder: string | null;
  processing: string | null;
  lastActiveAt: string | null;
}

export interface HyperNeoSessionsControl {
  archive?: WorkAdapter['archive'];
  create(workspacePath: string, title: string, model?: string): Promise<string>;
  resolveModel(model: string): Promise<string | null>;
  model(sessionId: string): string | null;
  chooseWorktree(sessionId: string): Promise<void>;
  announce(sessionId: string): void;
  interrupt(sessionId: string): boolean;
}

export interface HyperNeoSessionsAdapterDeps {
  prepareExecution?: WorkExecutionPreparer;
  projects?: () => NonNullable<WorkspaceHistoryEntry['project']>[];
  db: () => BunDatabase;
  machine: string;
  searchChats: (text: string) => Promise<readonly WorkChatMatch[]>;
  handoff: (
    sessionId: string,
    message: string,
    from: string,
    messageUuid: string
  ) => Promise<MailboxHandoffOutcome>;
  sessions: HyperNeoSessionsControl;
  neoFolder: () => string;
  folderExists: (folder: string) => boolean;
  makeFolder: (folder: string) => void;
  homeDir: string;
  liveCards?: () => ReadonlyMap<string, number>;
}

export interface HyperNeoSessionsLastResult {
  reply: string | null;
  failed: number | null;
  at: string | null;
}

type Gate<Value> = { value: Value } | { reason: Rejected };

export function hyperNeoSessionsWorkStatus(status: string, processing: string | null): WorkStatus {
  if (status === 'archived' || status === 'ended' || processing === 'interrupted') return 'stopped';
  if (processing === 'interrupted_by_restart') return 'queued';
  if (status === 'pending_worktree_choice' || processing === 'waiting_for_input')
    return 'needs_you';
  if (processing === 'processing') return 'running';
  return processing === 'queued' || processing === 'rate_limit_cooldown' ? 'queued' : 'done';
}

function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function placeName(folder: string | null): string {
  return folder ? basename(folder.replace(/[\\/]+$/, '')) || folder : 'Chats';
}

export function readHyperNeoSessionsPlaces(db: BunDatabase): HyperNeoSessionsPlaceRow[] {
  return db
    .prepare(
      `SELECT folder, SUM(open) AS openCount, SUM(archived) AS archivedCount, MAX(known) AS known,
         MAX(lastActiveAt) AS lastActiveAt
         FROM (
           SELECT ${FOLDER} AS folder, CASE WHEN ${OPEN} THEN 1 ELSE 0 END AS open,
             CASE WHEN status = 'archived' THEN 1 ELSE 0 END AS archived, 0 AS known,
             last_active_at AS lastActiveAt
             FROM sessions WHERE ${OWN_SESSIONS}
           UNION ALL
           SELECT path, 0, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at / 1000.0, 'unixepoch')
             FROM workspace_history
         )
        GROUP BY folder`
    )
    .all() as HyperNeoSessionsPlaceRow[];
}

export function readHyperNeoSessions(
  db: BunDatabase,
  includeClosed: boolean
): HyperNeoSessionsRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT ${SESSION_COLUMNS} FROM sessions WHERE ${OWN_SESSIONS} AND ${OPEN}
         UNION ALL
         SELECT * FROM (SELECT ${SESSION_COLUMNS} FROM sessions
           WHERE ${OWN_SESSIONS} AND ? = 1 AND NOT ${OPEN}
           ORDER BY lastActiveAt DESC LIMIT ${CLOSED_SESSIONS}))
       ORDER BY lastActiveAt DESC`
    )
    .all(includeClosed ? 1 : 0) as HyperNeoSessionsRow[];
}

export function withSessionLoad(work: WorkSummary, liveCards: number): WorkSummary {
  const busy = work.status === 'running' || work.status === 'queued';
  return {
    ...work,
    ...(liveCards > 0 ? { liveCards } : {}),
    ...(busy ? { busy: true as const } : {}),
  };
}

function toWork(row: HyperNeoSessionsRow, machine: string): WorkSummary {
  return {
    ref: { adapter: 'hyperneo-sessions', id: row.id },
    title: row.title,
    place: { machine, ...(row.folder ? { folder: row.folder } : {}), name: placeName(row.folder) },
    status: hyperNeoSessionsWorkStatus(row.status, row.processing),
    lastActivityAt: timestamp(row.lastActiveAt),
    link: `/session/${row.id}`,
  };
}

export function buildHyperNeoSessionsGroups(
  places: readonly HyperNeoSessionsPlaceRow[],
  sessions: readonly HyperNeoSessionsRow[],
  query: FindQuery,
  deps: Pick<HyperNeoSessionsAdapterDeps, 'machine'>,
  matched: ReadonlyMap<string, WorkChatMatch>,
  liveCards: ReadonlyMap<string, number> = new Map(),
  projects: NonNullable<WorkspaceHistoryEntry['project']>[] = []
): PlaceGroup[] {
  const machine = deps.machine;
  const text = query.text?.toLowerCase();
  return places
    .filter((place) => !query.folder || place.folder === query.folder)
    .filter((place) => query.includeClosed || place.openCount > 0 || place.known > 0)
    .flatMap((place) => {
      const project = projects.find((project) => project.folders.includes(place.folder ?? ''));
      const toolProject = project
        ? { id: `hyperneo:${project.id}`, name: project.name }
        : undefined;
      const placeMatches =
        !text ||
        `${project?.name ?? placeName(place.folder)} ${place.folder ?? ''}`
          .toLowerCase()
          .includes(text);
      const work = sessions
        .filter((session) => session.folder === place.folder)
        .filter(
          (session) =>
            placeMatches ||
            matched.has(session.id) ||
            session.title.toLowerCase().includes(text ?? '')
        )
        .map((session) =>
          withSessionLoad(
            withChatEvidence(toWork(session, machine), matched.get(session.id)),
            liveCards.get(session.id) ?? 0
          )
        )
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .slice(0, SESSIONS_PER_PLACE);
      if (!placeMatches && work.length === 0) return [];
      return [
        {
          place: {
            machine,
            ...(place.folder ? { folder: place.folder } : {}),
            name: project?.name ?? placeName(place.folder),
            ...(toolProject ? { toolProject } : {}),
          },
          lastActivityAt: timestamp(place.lastActiveAt),
          openCount: place.openCount,
          archivedCount: place.archivedCount,
          adapters: ['hyperneo-sessions'],
          work: work.map((item) => ({
            ...item,
            place: { ...item.place, ...(toolProject ? { toolProject } : {}) },
          })),
        },
      ];
    });
}

export function loadHyperNeoSessionsPlaces(
  deps: HyperNeoSessionsAdapterDeps
): HyperNeoSessionsPlaceRow[] {
  return readHyperNeoSessionsPlaces(deps.db());
}

export function loadHyperNeoSessions(
  query: FindQuery,
  deps: HyperNeoSessionsAdapterDeps
): HyperNeoSessionsRow[] {
  return readHyperNeoSessions(deps.db(), query.includeClosed);
}

export function matchHyperNeoSessions(
  chats: readonly WorkChatMatch[]
): ReadonlyMap<string, WorkChatMatch> {
  return matchChatsBy(chats, (chat) => (chat.taskId === null ? chat.sessionId : null));
}

export function skipSpaceQuery(query: FindQuery): { value: FindQuery } | { reason: PlaceGroup[] } {
  return query.spaceId ? { reason: [] } : { value: query };
}

function insideNeo(folder: string | null, root: string): boolean {
  return !!folder && folder.startsWith(`${root}${sep}`);
}

export function foldNeoPlaces(
  places: readonly HyperNeoSessionsPlaceRow[],
  root: string
): HyperNeoSessionsPlaceRow[] {
  const folded = new Map<string | null, HyperNeoSessionsPlaceRow>();
  for (const place of places) {
    const folder = insideNeo(place.folder, root) ? root : place.folder;
    const seen = folded.get(folder);
    folded.set(
      folder,
      seen
        ? {
            folder,
            openCount: seen.openCount + place.openCount,
            archivedCount: seen.archivedCount + place.archivedCount,
            known: Math.max(seen.known, place.known),
            lastActiveAt:
              (seen.lastActiveAt ?? '') > (place.lastActiveAt ?? '')
                ? seen.lastActiveAt
                : place.lastActiveAt,
          }
        : { ...place, folder }
    );
  }
  return [...folded.values()];
}

export function foldNeoSessions(
  sessions: readonly HyperNeoSessionsRow[],
  root: string
): HyperNeoSessionsRow[] {
  return sessions.map((session) =>
    insideNeo(session.folder, root) ? { ...session, folder: root } : session
  );
}

const runHyperNeoSessionsFind = (superpipe({})('hyperneo-find-work') as PipelineAPI)
  .input(['query', 'deps', 'chats'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadHyperNeoSessionsPlaces, 'deps', 'rawPlaces')
  .pipe(loadHyperNeoSessions, ['query', 'deps'], 'rawSessions')
  .pipe((deps: HyperNeoSessionsAdapterDeps) => deps.neoFolder(), 'deps', 'neoRoot')
  .pipe(foldNeoPlaces, ['rawPlaces', 'neoRoot'], 'places')
  .pipe(foldNeoSessions, ['rawSessions', 'neoRoot'], 'sessions')
  .pipe(matchHyperNeoSessions, 'chats', 'matched')
  .pipe((deps: HyperNeoSessionsAdapterDeps) => deps.liveCards?.() ?? new Map(), 'deps', 'liveCards')
  .pipe((deps: HyperNeoSessionsAdapterDeps) => deps.projects?.() ?? [], 'deps', 'projects')
  .pipe(
    buildHyperNeoSessionsGroups,
    ['places', 'sessions', 'query', 'deps', 'matched', 'liveCards', 'projects'],
    'groups'
  )
  .end('groups') as (
  query: FindQuery,
  deps: HyperNeoSessionsAdapterDeps,
  chats: readonly WorkChatMatch[]
) => PlaceGroup[];

export function hyperNeoSessionsSessionBusy(row: HyperNeoSessionsRow): boolean {
  const status = hyperNeoSessionsWorkStatus(row.status, row.processing);
  return status === 'running' || status === 'queued';
}

export function readHyperNeoSession(db: BunDatabase, id: string): HyperNeoSessionsRow | null {
  const row = db
    .prepare(
      `SELECT id, title, status, ${FOLDER} AS folder, last_active_at AS lastActiveAt,
         ${PROCESSING} AS processing FROM sessions WHERE id = ? AND ${OWN_SESSIONS}`
    )
    .get(id) as HyperNeoSessionsRow | null | undefined;
  return row ?? null;
}

export function readHyperNeoSessionsLastResult(
  db: BunDatabase,
  id: string
): HyperNeoSessionsLastResult | null {
  const row = db
    .prepare(
      `SELECT json_extract(sdk_message, '$.result') AS reply, json_extract(sdk_message, '$.is_error') AS failed,
              timestamp AS at
         FROM sdk_messages WHERE session_id = ? AND message_type = 'result' AND parent_tool_use_id IS NULL
          AND COALESCE(json_extract(sdk_message, '$.internal_compaction_turn'), 0) = 0
        ORDER BY timestamp DESC LIMIT 1`
    )
    .get(id) as HyperNeoSessionsLastResult | null | undefined;
  return row ?? null;
}

export function hyperNeoSessionsInputText(message: string): string {
  const content = (JSON.parse(message) as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .flatMap((block: { type?: string; text?: string }) =>
          block.type === 'text' && block.text ? [block.text] : []
        )
        .join(' ')
    : '';
}

export function readHyperNeoSessionsInputs(
  db: BunDatabase,
  id: string,
  since?: number
): WorkInput[] {
  const rows = (
    since === undefined
      ? db
          .prepare(
            `SELECT timestamp, sdk_message AS message FROM sdk_messages
              WHERE session_id = ? AND ${LANDED_INPUT} ORDER BY timestamp DESC LIMIT ${TAIL_INPUTS}`
          )
          .all(id)
          .reverse()
      : db
          .prepare(
            `SELECT timestamp, sdk_message AS message FROM sdk_messages
              WHERE session_id = ? AND timestamp > ? AND ${LANDED_INPUT}
              ORDER BY timestamp ASC LIMIT ${INPUTS_AFTER}`
          )
          .all(id, new Date(since).toISOString())
  ) as { timestamp: string; message: string }[];
  const inputs = rows.flatMap((row) => {
    const input = workInput(
      workEntryTime(row.timestamp),
      hyperNeoSessionsInputText(row.message),
      JSON.parse(row.message).inputKind === 'human'
    );
    return input ? [input] : [];
  });
  return recentWorkInputs(inputs, since);
}

type HyperNeoSessionsExchangeRow = { timestamp: string; message: string; message_type: string };

function projectHyperNeoSessionsExchange(rows: HyperNeoSessionsExchangeRow[], since: number) {
  const entries = rows.flatMap((row) => {
    const user = row.message_type === 'user';
    const raw = user
      ? hyperNeoSessionsInputText(row.message)
      : (JSON.parse(row.message).result as string | undefined);
    const text = raw?.trim() || (user ? '[Non-text input]' : '[No written result]');
    const entry = exchangeEntry(workEntryTime(row.timestamp), user ? 'user' : 'agent', text, since);
    return entry ? [entry] : [];
  });
  return boundExchange(entries, rows.length > 40);
}

export function readHyperNeoSessionsExchange(db: BunDatabase, id: string, since: number) {
  const rows = db
    .prepare(
      `SELECT timestamp, sdk_message AS message, message_type FROM sdk_messages
      WHERE session_id = ? AND timestamp > ? AND parent_tool_use_id IS NULL
        AND COALESCE(json_extract(sdk_message, '$.internal_compaction_turn'), 0) = 0
        AND (message_type = 'result' OR (message_type = 'user'
          AND COALESCE(send_status, 'consumed') = 'consumed'
          AND COALESCE(json_extract(sdk_message, '$.message.content[0].type'), 'text') <> 'tool_result'))
      ORDER BY timestamp DESC, rowid DESC LIMIT 41`
    )
    .all(id, new Date(since).toISOString())
    .reverse() as HyperNeoSessionsExchangeRow[];
  return projectHyperNeoSessionsExchange(rows, since);
}

export function requireHyperNeoSessions(
  ref: WorkRef,
  deps: HyperNeoSessionsAdapterDeps
): Gate<HyperNeoSessionsRow> {
  const row = readHyperNeoSession(deps.db(), ref.id);
  return row ? { value: row } : { reason: reject('not_found', `No HyperNeo session ${ref.id}.`) };
}

export function requireOpenHyperNeoSessions(row: HyperNeoSessionsRow): Gate<HyperNeoSessionsRow> {
  return sessionUnavailable(row.status)
    ? {
        reason: reject(
          'not_open',
          `Session ${row.id} is ${row.status} and cannot receive messages.`
        ),
      }
    : { value: row };
}

export function describeHyperNeoSessionsWork(
  row: HyperNeoSessionsRow,
  deps: HyperNeoSessionsAdapterDeps,
  since?: number
): Result<WorkDetail> {
  const work = toWork(row, deps.machine);
  const last = readHyperNeoSessionsLastResult(deps.db(), row.id);
  return {
    ok: true,
    value: {
      ...work,
      status: work.status === 'done' && last?.failed ? 'failed' : work.status,
      ...(last?.reply
        ? { lastReply: last.reply.slice(0, REPLY_LIMIT), lastReplyAt: timestamp(last.at) }
        : {}),
      recentInputs: readHyperNeoSessionsInputs(deps.db(), row.id, since),
      ...withExchange(
        since === undefined ? undefined : readHyperNeoSessionsExchange(deps.db(), row.id, since)
      ),
    },
  };
}

export async function deliverToHyperNeoSessions(
  row: HyperNeoSessionsRow,
  message: string,
  context: WorkCallContext,
  deps: HyperNeoSessionsAdapterDeps
): Promise<Result<WorkDelivery>> {
  const inputId = crypto.randomUUID();
  const outcome = await deps.handoff(row.id, message, context.from, inputId);
  if (outcome.kind === 'rejected') return reject('not_delivered', outcome.reason);
  return {
    ok: true,
    value: {
      delivered: !hyperNeoSessionsSessionBusy(row),
      receipt: { executionId: row.id, inputId },
    },
  };
}

export function selectStartFolder(
  request: StartRequest,
  deps: HyperNeoSessionsAdapterDeps
): Gate<string> {
  const admitted = workStartPreparation.admit(request.preparation, !!deps.prepareExecution);
  if ('reason' in admitted) return admitted;
  return selectLocalStartFolder(request, deps, 'Start new work in a project folder or a Space.');
}

export async function createHyperNeoSessions(
  folder: string,
  request: StartRequest,
  deps: HyperNeoSessionsAdapterDeps
): Promise<Gate<string>> {
  const prepared = request.preparation
    ? await deps.prepareExecution!(request.preparation, {
        directory: folder,
        destination: join(deps.neoFolder(), 'worktrees', crypto.randomUUID()),
      })
    : null;
  if (prepared && !prepared.ok) return { reason: prepared };
  let sessionId: string | undefined;
  try {
    sessionId = await deps.sessions.create(
      prepared?.value.directory ?? folder,
      request.title,
      request.model
    );
  } catch (error) {
    if (request.model !== undefined && error instanceof ModelUnavailableError)
      return { reason: reject('unsupported_model', error.message) };
    throw error;
  } finally {
    if (!sessionId) await prepared?.value.release();
  }
  if (readHyperNeoSession(deps.db(), sessionId)?.status === 'pending_worktree_choice') {
    await deps.sessions.chooseWorktree(sessionId);
  }
  deps.sessions.announce(sessionId);
  return { value: sessionId };
}

async function requireHyperNeoSessionsStartConfiguration(
  request: StartRequest,
  deps: HyperNeoSessionsAdapterDeps
): Promise<Gate<StartRequest>> {
  if (request.effort !== undefined)
    return { reason: reject('unsupported_effort', 'HyperNeo cannot confirm a requested effort.') };
  if (request.model === undefined) return { value: request };
  const model = await deps.sessions.resolveModel(request.model);
  return model
    ? { value: { ...request, model } }
    : { reason: reject('unsupported_model', `No available model matches ${request.model}.`) };
}

function confirmHyperNeoSessionsStart(
  sessionId: string,
  request: StartRequest,
  deps: HyperNeoSessionsAdapterDeps
): Gate<{ sessionId: string; model: string | null }> {
  const model = deps.sessions.model(sessionId);
  const confirmed = workStartConfiguration.confirm(request, model ? { model } : {});
  return confirmed.ok
    ? { value: { sessionId, model } }
    : {
        reason: reject(
          confirmed.reason,
          `${confirmed.detail} Session ${sessionId} was created without its first message.`
        ),
      };
}

export async function openHyperNeoSessionsWork(
  confirmed: { sessionId: string; model: string | null },
  request: StartRequest,
  context: WorkCallContext,
  deps: HyperNeoSessionsAdapterDeps
): Promise<Result<WorkStarted>> {
  const { sessionId, model } = confirmed;
  const inputId = crypto.randomUUID();
  const outcome = await deps.handoff(sessionId, request.message, context.from, inputId);
  if (outcome.kind === 'rejected') {
    return reject(
      'not_delivered',
      `Session ${sessionId} started without its message: ${outcome.reason}`
    );
  }
  const row = readHyperNeoSession(deps.db(), sessionId);
  if (!row) return reject('not_found', `Session ${sessionId} is gone.`);
  const work = toWork(row, deps.machine);
  return {
    ok: true,
    value: {
      ...work,
      ...(work.status === 'done' ? { status: 'queued' as const } : {}),
      ...(model ? { model } : {}),
      receipt: { executionId: sessionId, inputId },
    },
  };
}

export function stopHyperNeoSessionsWork(
  row: HyperNeoSessionsRow,
  deps: HyperNeoSessionsAdapterDeps
): Result<{ stopped: boolean }> {
  return {
    ok: true,
    value: { stopped: hyperNeoSessionsSessionBusy(row) && deps.sessions.interrupt(row.id) },
  };
}

const runHyperNeoSessionsStart = (superpipe({})('hyperneo-start-work') as PipelineAPI)
  .input(['request', 'context', 'deps'])
  .pipe(requireHyperNeoSessionsStartConfiguration, ['request', 'deps'], 'result:outcome')
  .pipe((request: StartRequest) => request, 'outcome', 'configured')
  .pipe(selectStartFolder, ['configured', 'deps'], 'result:outcome')
  .pipe(createHyperNeoSessions, ['outcome', 'configured', 'deps'], 'result:outcome')
  .pipe(confirmHyperNeoSessionsStart, ['outcome', 'configured', 'deps'], 'result:outcome')
  .pipe(openHyperNeoSessionsWork, ['outcome', 'configured', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  request: StartRequest,
  context: WorkCallContext,
  deps: HyperNeoSessionsAdapterDeps
) => Promise<Result<WorkStarted>>;

const runHyperNeoSessionsStop = (superpipe({})('hyperneo-stop-work') as PipelineAPI)
  .input(['ref', 'deps'])
  .pipe(requireHyperNeoSessions, ['ref', 'deps'], 'result:outcome')
  .pipe(stopHyperNeoSessionsWork, ['outcome', 'deps'], 'outcome')
  .end('outcome') as (
  ref: WorkRef,
  deps: HyperNeoSessionsAdapterDeps
) => Result<{ stopped: boolean }>;

export function withHyperNeoSessionsInputEvidence(
  outcome: Result<WorkDetail>,
  row: HyperNeoSessionsRow,
  deps: HyperNeoSessionsAdapterDeps,
  receipt: WorkDelivery['receipt']
): Result<WorkDetail> {
  return outcome.ok && receipt
    ? {
        ok: true,
        value: {
          ...outcome.value,
          inputEvidence: readSessionInputEvidence(deps.db(), row.id, receipt),
        },
      }
    : outcome;
}

const runHyperNeoSessionsStatus = (superpipe({})('hyperneo-work-status') as PipelineAPI)
  .input(['ref', 'deps', 'since', 'receipt'])
  .pipe(requireHyperNeoSessions, ['ref', 'deps'], 'result:outcome')
  .pipe((row: HyperNeoSessionsRow) => row, 'outcome', 'row')
  .pipe(describeHyperNeoSessionsWork, ['row', 'deps', 'since'], 'outcome')
  .pipe(withHyperNeoSessionsInputEvidence, ['outcome', 'row', 'deps', 'receipt'], 'outcome')
  .end('outcome') as (
  ref: WorkRef,
  deps: HyperNeoSessionsAdapterDeps,
  since?: number,
  receipt?: WorkDelivery['receipt']
) => Result<WorkDetail>;

const runHyperNeoSessionsSend = (superpipe({})('hyperneo-send-work') as PipelineAPI)
  .input(['ref', 'message', 'context', 'deps'])
  .pipe(requireHyperNeoSessions, ['ref', 'deps'], 'result:outcome')
  .pipe(requireOpenHyperNeoSessions, 'outcome', 'result:outcome')
  .pipe(deliverToHyperNeoSessions, ['outcome', 'message', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  context: WorkCallContext,
  deps: HyperNeoSessionsAdapterDeps
) => Promise<Result<WorkDelivery>>;

export function createHyperNeoSessionsAdapter(deps: HyperNeoSessionsAdapterDeps): WorkAdapter {
  return {
    id: 'hyperneo-sessions',
    supportsStartPreparation: !!deps.prepareExecution,
    capabilities: [
      'find',
      'start',
      'send',
      'status',
      'stop',
      ...(deps.sessions.archive ? ['archive' as const] : []),
    ],
    find: async (query) =>
      runHyperNeoSessionsFind(
        query,
        deps,
        query.text && !query.spaceId ? await deps.searchChats(query.text) : []
      ),
    start: (request, context) => runHyperNeoSessionsStart(request, context, deps),
    send: (ref, message, context) => runHyperNeoSessionsSend(ref, message, context, deps),
    status: async (ref, since, receipt) => runHyperNeoSessionsStatus(ref, deps, since, receipt),
    stop: async (ref) => runHyperNeoSessionsStop(ref, deps),
    archive: async (ref, admit) => {
      const check = () => {
        const found = requireHyperNeoSessions(ref, deps);
        if ('reason' in found) return found.reason;
        return ['running', 'queued', 'needs_you'].includes(
          hyperNeoSessionsWorkStatus(found.value.status, found.value.processing)
        )
          ? reject('busy', 'The HyperNeo session still has a live turn.')
          : admit();
      };
      const refused = check();
      if (refused) return refused;
      return (
        deps.sessions.archive?.(ref, check) ?? reject('unsupported', 'Archive is unavailable.')
      );
    },
  };
}
