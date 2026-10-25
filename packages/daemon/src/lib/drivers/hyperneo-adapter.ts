import { installClaudeNativeWrites } from './claude-native-writes.ts';
import { releaseWorkerSandbox } from './worker-sandbox.ts';
import { THINKING_OPTIONS } from '@hyperneo/shared';
import { sdkMessageBodyAt } from '../../storage/repositories/sdk-message-body-read.ts';
import { workStartPreparation, type WorkExecutionPreparer } from './start-preparation.ts';
import { workExecutionLocation } from './execution-location.ts';
import { basename, join, sep } from 'node:path';
import type { WorkspaceHistoryEntry } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import type { MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import type { MailboxDeliveryMode } from '../mailbox/entry.ts';
import { sessionUnavailable } from '../session-resolution/session-lookup.ts';
import { withReplyLine } from '../messaging/session-reply.ts';
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
  WorkWithdrawal,
} from './types.ts';
import { readHyperneoTodoEvidence } from './hyperneo-todo-evidence.ts';
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
  AND COALESCE(input_kind, '') <> 'system'
  AND COALESCE(first_block_type, 'text') = 'text'`;

export interface HyperneoPlaceRow {
  folder: string | null;
  openCount: number;
  archivedCount: number;
  known: number;
  lastActiveAt: string | null;
}

export interface HyperneoSessionRow {
  id: string;
  title: string;
  status: string;
  folder: string | null;
  processing: string | null;
  lastActiveAt: string | null;
  branch?: string | null;
  directory?: string | null;
}

export interface HyperneoSessionControl {
  rename?: WorkAdapter['rename'];
  archive?: WorkAdapter['archive'];
  withdraw?: (
    sessionId: string,
    queuedSubmissionId: string,
    from: string
  ) => Promise<Result<WorkWithdrawal>>;
  create(
    workspacePath: string,
    title: string,
    model?: string,
    provider?: string,
    effort?: string,
    inPlace?: boolean
  ): Promise<string>;
  resolveModel(model: string): Promise<{ id: string; provider: string } | null>;
  effort?(sessionId: string): string | null;
  model(sessionId: string): string | null;
  chooseWorktree(sessionId: string): Promise<void>;
  announce(sessionId: string): void;
  interrupt(sessionId: string): boolean | Promise<boolean>;
}

export interface HyperneoAdapterDeps {
  prepareExecution?: WorkExecutionPreparer;
  projects?: () => NonNullable<WorkspaceHistoryEntry['project']>[];
  db: () => BunDatabase;
  machine: string;
  searchChats: (text: string) => Promise<readonly WorkChatMatch[]>;
  handoff: (
    sessionId: string,
    message: string,
    from: string,
    messageUuid: string,
    deliveryMode?: MailboxDeliveryMode
  ) => Promise<MailboxHandoffOutcome>;
  sessions: HyperneoSessionControl;
  neoFolder: () => string;
  folderExists: (folder: string) => boolean;
  makeFolder: (folder: string) => void;
  homeDir: string;
}

export interface HyperneoLastResult {
  reply: string | null;
  failed: number | null;
  at: string | null;
}

type Gate<Value> = { value: Value } | { reason: Rejected };

export function hyperneoWorkStatus(status: string, processing: string | null): WorkStatus {
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

export function readHyperneoPlaces(db: BunDatabase): HyperneoPlaceRow[] {
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
    .all() as HyperneoPlaceRow[];
}

export function readHyperneoSessions(
  db: BunDatabase,
  includeClosed: boolean
): HyperneoSessionRow[] {
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
    .all(includeClosed ? 1 : 0) as HyperneoSessionRow[];
}

export function withSessionLoad(work: WorkSummary): WorkSummary {
  const busy = work.status === 'running' || work.status === 'queued';
  return busy ? { ...work, busy: true as const } : work;
}

function toWork(row: HyperneoSessionRow, machine: string): WorkSummary {
  return {
    ref: { adapter: 'hyperneo', id: row.id },
    title: row.title,
    place: { machine, ...(row.folder ? { folder: row.folder } : {}), name: placeName(row.folder) },
    status: hyperneoWorkStatus(row.status, row.processing),
    lastActivityAt: timestamp(row.lastActiveAt),
    link: `/session/${row.id}`,
  };
}

export function buildHyperneoGroups(
  places: readonly HyperneoPlaceRow[],
  sessions: readonly HyperneoSessionRow[],
  query: FindQuery,
  deps: Pick<HyperneoAdapterDeps, 'machine'>,
  matched: ReadonlyMap<string, WorkChatMatch>,
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
          withSessionLoad(withChatEvidence(toWork(session, machine), matched.get(session.id)))
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
          adapters: ['hyperneo'],
          work: work.map((item) => ({
            ...item,
            place: { ...item.place, ...(toolProject ? { toolProject } : {}) },
          })),
        },
      ];
    });
}

export function loadHyperneoPlaces(deps: HyperneoAdapterDeps): HyperneoPlaceRow[] {
  return readHyperneoPlaces(deps.db());
}

export function loadHyperneoSessions(
  query: FindQuery,
  deps: HyperneoAdapterDeps
): HyperneoSessionRow[] {
  return readHyperneoSessions(deps.db(), query.includeClosed);
}

export function matchHyperneoSessions(
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
  places: readonly HyperneoPlaceRow[],
  root: string
): HyperneoPlaceRow[] {
  const folded = new Map<string | null, HyperneoPlaceRow>();
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
  sessions: readonly HyperneoSessionRow[],
  root: string
): HyperneoSessionRow[] {
  return sessions.map((session) =>
    insideNeo(session.folder, root) ? { ...session, folder: root } : session
  );
}

const runHyperneoFind = (superpipe({})('hyperneo-find-work') as PipelineAPI)
  .input(['query', 'deps', 'chats'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadHyperneoPlaces, 'deps', 'rawPlaces')
  .pipe(loadHyperneoSessions, ['query', 'deps'], 'rawSessions')
  .pipe((deps: HyperneoAdapterDeps) => deps.neoFolder(), 'deps', 'neoRoot')
  .pipe(foldNeoPlaces, ['rawPlaces', 'neoRoot'], 'places')
  .pipe(foldNeoSessions, ['rawSessions', 'neoRoot'], 'sessions')
  .pipe(matchHyperneoSessions, 'chats', 'matched')
  .pipe((deps: HyperneoAdapterDeps) => deps.projects?.() ?? [], 'deps', 'projects')
  .pipe(
    buildHyperneoGroups,
    ['places', 'sessions', 'query', 'deps', 'matched', 'projects'],
    'groups'
  )
  .end('groups') as (
  query: FindQuery,
  deps: HyperneoAdapterDeps,
  chats: readonly WorkChatMatch[]
) => PlaceGroup[];

export function hyperneoSessionBusy(row: HyperneoSessionRow): boolean {
  const status = hyperneoWorkStatus(row.status, row.processing);
  return status === 'running' || status === 'queued';
}

export function readHyperneoSession(db: BunDatabase, id: string): HyperneoSessionRow | null {
  const row = db
    .prepare(
      `SELECT id, title, status, ${FOLDER} AS folder, last_active_at AS lastActiveAt,
         ${PROCESSING} AS processing, COALESCE(worktree_branch, git_branch) AS branch,
         COALESCE(worktree_path, workspace_path) AS directory
         FROM sessions WHERE id = ? AND ${OWN_SESSIONS}`
    )
    .get(id) as HyperneoSessionRow | null | undefined;
  return row ?? null;
}

export function readHyperneoTurnEnds(
  db: BunDatabase,
  sessionId: string,
  since?: number
): NonNullable<WorkDetail['turnEnds']> {
  if (since === undefined) return [];
  const rows = db
    .prepare(`SELECT CAST(m.rowid AS TEXT) AS id, m.timestamp,
    COALESCE(NULLIF(json_extract(${sdkMessageBodyAt('m.rowid')}, '$.result'), ''),
      (SELECT group_concat(json_extract(block.value, '$.text'), char(10)) FROM json_each((
        SELECT CASE json_type(${sdkMessageBodyAt('a.rowid')}, '$.message.content')
          WHEN 'array' THEN json_extract(${sdkMessageBodyAt('a.rowid')}, '$.message.content') ELSE '[]' END
        FROM sdk_messages a WHERE a.session_id=m.session_id AND a.message_type='assistant'
          AND a.parent_tool_use_id IS NULL AND a.rowid<m.rowid AND COALESCE(a.internal_compaction_turn,0)=0
          AND a.rowid>COALESCE((SELECT MAX(p.rowid) FROM sdk_messages p
            WHERE p.session_id=m.session_id AND p.message_type='result' AND p.parent_tool_use_id IS NULL
              AND COALESCE(p.internal_compaction_turn,0)=0 AND p.rowid<m.rowid
              AND NOT (COALESCE(p.recovery_intercepted,0)=1 AND COALESCE(p.recovery_billing_terminal,0)=0)),0)
        ORDER BY a.rowid DESC LIMIT 1
      )) block WHERE json_extract(block.value, '$.type')='text'), '') AS message
    FROM sdk_messages m WHERE m.session_id=? AND m.message_type='result' AND m.parent_tool_use_id IS NULL
      AND COALESCE(m.internal_compaction_turn,0)=0
      AND NOT (COALESCE(m.recovery_intercepted,0)=1 AND COALESCE(m.recovery_billing_terminal,0)=0)
      AND m.timestamp>? ORDER BY m.rowid`)
    .all(sessionId, new Date(since).toISOString()) as {
    id: string;
    timestamp: string;
    message: string;
  }[];
  return rows.flatMap((row) => {
    const at = workEntryTime(row.timestamp);
    return at === undefined ? [] : [{ id: row.id, at, message: row.message }];
  });
}

export function readHyperneoLastResult(db: BunDatabase, id: string): HyperneoLastResult | null {
  const row = db
    .prepare(
      `SELECT json_extract(${sdkMessageBodyAt('sdk_messages.rowid')}, '$.result') AS reply, json_extract(${sdkMessageBodyAt('sdk_messages.rowid')}, '$.is_error') AS failed,
              timestamp AS at
         FROM sdk_messages WHERE session_id = ? AND message_type = 'result' AND parent_tool_use_id IS NULL
          AND COALESCE(internal_compaction_turn, 0) = 0
        ORDER BY timestamp DESC LIMIT 1`
    )
    .get(id) as HyperneoLastResult | null | undefined;
  return row ?? null;
}

export function hyperneoInputText(message: string): string {
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

export function readHyperneoInputs(db: BunDatabase, id: string, since?: number): WorkInput[] {
  const rows = (
    since === undefined
      ? db
          .prepare(
            `SELECT timestamp, ${sdkMessageBodyAt('sdk_messages.rowid')} AS message FROM sdk_messages
              WHERE session_id = ? AND ${LANDED_INPUT} ORDER BY timestamp DESC LIMIT ${TAIL_INPUTS}`
          )
          .all(id)
          .reverse()
      : db
          .prepare(
            `SELECT timestamp, ${sdkMessageBodyAt('sdk_messages.rowid')} AS message FROM sdk_messages
              WHERE session_id = ? AND timestamp > ? AND ${LANDED_INPUT}
              ORDER BY timestamp ASC LIMIT ${INPUTS_AFTER}`
          )
          .all(id, new Date(since).toISOString())
  ) as { timestamp: string; message: string }[];
  const inputs = rows.flatMap((row) => {
    const input = workInput(
      workEntryTime(row.timestamp),
      hyperneoInputText(row.message),
      JSON.parse(row.message).inputKind === 'human'
    );
    return input ? [input] : [];
  });
  return recentWorkInputs(inputs, since);
}

type HyperneoExchangeRow = { timestamp: string; message: string; message_type: string };

function projectHyperneoExchange(rows: HyperneoExchangeRow[], since: number) {
  const entries = rows.flatMap((row) => {
    const user = row.message_type === 'user';
    const raw = user
      ? hyperneoInputText(row.message)
      : (JSON.parse(row.message).result as string | undefined);
    const text = raw?.trim() || (user ? '[Non-text input]' : '[No written result]');
    const entry = exchangeEntry(workEntryTime(row.timestamp), user ? 'user' : 'agent', text, since);
    return entry ? [entry] : [];
  });
  return boundExchange(entries, rows.length > 40);
}

export function readHyperneoExchange(db: BunDatabase, id: string, since: number) {
  const rows = db
    .prepare(
      `SELECT timestamp, ${sdkMessageBodyAt('sdk_messages.rowid')} AS message, message_type FROM sdk_messages
      WHERE session_id = ? AND timestamp > ? AND parent_tool_use_id IS NULL
        AND COALESCE(internal_compaction_turn, 0) = 0
        AND (message_type = 'result' OR (message_type = 'user'
          AND COALESCE(send_status, 'consumed') = 'consumed'
          AND COALESCE(first_block_type, 'text') <> 'tool_result'))
      ORDER BY timestamp DESC, rowid DESC LIMIT 41`
    )
    .all(id, new Date(since).toISOString())
    .reverse() as HyperneoExchangeRow[];
  return projectHyperneoExchange(rows, since);
}

export function requireHyperneoSession(
  ref: WorkRef,
  deps: HyperneoAdapterDeps
): Gate<HyperneoSessionRow> {
  const row = readHyperneoSession(deps.db(), ref.id);
  return row ? { value: row } : { reason: reject('not_found', `No HyperNeo session ${ref.id}.`) };
}

export function requireOpenHyperneoSession(row: HyperneoSessionRow): Gate<HyperneoSessionRow> {
  return sessionUnavailable(row.status)
    ? {
        reason: reject(
          'not_open',
          `Session ${row.id} is ${row.status} and cannot receive messages.`
        ),
      }
    : { value: row };
}

export function describeHyperneoWork(
  row: HyperneoSessionRow,
  deps: HyperneoAdapterDeps,
  since?: number
): Result<WorkDetail> {
  const work = toWork(row, deps.machine);
  const turnEnds = readHyperneoTurnEnds(deps.db(), row.id, since);
  const last = readHyperneoLastResult(deps.db(), row.id);
  return {
    ok: true,
    value: {
      ...work,
      ...(turnEnds.length ? { turnEnds } : {}),
      status: work.status === 'done' && last?.failed ? 'failed' : work.status,
      ...(last?.reply
        ? { lastReply: last.reply.slice(0, REPLY_LIMIT), lastReplyAt: timestamp(last.at) }
        : {}),
      recentInputs: readHyperneoInputs(deps.db(), row.id, since),
      ...(row.branch ? { branches: [row.branch] } : {}),
      ...workExecutionLocation(row.directory ?? undefined, deps.machine),
      ...withExchange(
        since === undefined ? undefined : readHyperneoExchange(deps.db(), row.id, since)
      ),
    },
  };
}

export async function deliverToHyperneo(
  row: HyperneoSessionRow,
  message: string,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps,
  deliveryMode?: MailboxDeliveryMode
): Promise<Result<WorkDelivery>> {
  const inputId = crypto.randomUUID();
  const outcome = await deps.handoff(
    row.id,
    withReplyLine(message, context.from),
    context.from,
    inputId,
    deliveryMode
  );
  if (outcome.kind === 'rejected') return reject('not_delivered', outcome.reason);
  return {
    ok: true,
    value: {
      delivered: deliveryMode !== 'defer' && !hyperneoSessionBusy(row),
      ...(deliveryMode === 'defer' ? { queuedSubmissionId: outcome.id } : {}),
      receipt: { executionId: row.id, inputId },
    },
  };
}

export function selectStartFolder(request: StartRequest, deps: HyperneoAdapterDeps): Gate<string> {
  const admitted = workStartPreparation.admit(request.preparation, !!deps.prepareExecution);
  if ('reason' in admitted) return admitted;
  return selectLocalStartFolder(request, deps, 'Start new work in a project folder or a Space.');
}

type HyperneoStartRequest = StartRequest & { provider?: string };

export async function createHyperneoSession(
  folder: string,
  request: HyperneoStartRequest,
  deps: HyperneoAdapterDeps
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
    if (prepared) await installClaudeNativeWrites(prepared.value.directory, [folder]);
    sessionId = await deps.sessions.create(
      prepared?.value.directory ?? folder,
      request.title,
      request.model,
      request.provider,
      request.effort,
      prepared ? true : request.inPlace
    );
  } catch (error) {
    if (request.model !== undefined && error instanceof ModelUnavailableError)
      return { reason: reject('unsupported_model', error.message) };
    throw error;
  } finally {
    if (!sessionId && prepared) {
      await prepared.value.release();
      await releaseWorkerSandbox(prepared.value.directory);
    }
  }
  if (readHyperneoSession(deps.db(), sessionId)?.status === 'pending_worktree_choice') {
    await deps.sessions.chooseWorktree(sessionId);
  }
  deps.sessions.announce(sessionId);
  return { value: sessionId };
}

async function requireHyperneoStartConfiguration(
  request: StartRequest,
  deps: HyperneoAdapterDeps
): Promise<Gate<HyperneoStartRequest>> {
  const effort =
    request.effort === undefined ? undefined : workStartConfiguration.normalize(request.effort);
  const thinking =
    effort === undefined
      ? undefined
      : THINKING_OPTIONS.find((entry) => [entry.value, entry.label.toLowerCase()].includes(effort));
  if (request.effort !== undefined && !thinking)
    return { reason: reject('unsupported_effort', `Unknown HyperNeo effort ${request.effort}.`) };
  const configured = { ...request, ...(thinking ? { effort: thinking.label.toLowerCase() } : {}) };
  if (request.model === undefined) return { value: configured };
  try {
    const model = await deps.sessions.resolveModel(request.model);
    return model
      ? { value: { ...configured, model: model.id, provider: model.provider } }
      : { reason: reject('unsupported_model', `No available model matches ${request.model}.`) };
  } catch (error) {
    if (error instanceof ModelUnavailableError)
      return { reason: reject('unsupported_model', error.message) };
    throw error;
  }
}

function confirmHyperneoStart(
  sessionId: string,
  request: StartRequest,
  deps: HyperneoAdapterDeps
): Gate<{ sessionId: string; model: string | null }> {
  const model = deps.sessions.model(sessionId);
  const confirmed = workStartConfiguration.confirm(request, {
    ...(model ? { model } : {}),
    ...(request.effort ? { effort: deps.sessions.effort?.(sessionId) ?? undefined } : {}),
  });
  return confirmed.ok
    ? { value: { sessionId, model } }
    : {
        reason: reject(
          confirmed.reason,
          `${confirmed.detail} Session ${sessionId} was created without its first message.`
        ),
      };
}

export async function openHyperneoWork(
  confirmed: { sessionId: string; model: string | null },
  request: StartRequest,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps
): Promise<Result<WorkStarted>> {
  const { sessionId, model } = confirmed;
  const inputId = crypto.randomUUID();
  const outcome = await deps.handoff(
    sessionId,
    withReplyLine(request.message, context.from),
    context.from,
    inputId
  );
  if (outcome.kind === 'rejected') {
    return reject(
      'not_delivered',
      `Session ${sessionId} started without its message: ${outcome.reason}`
    );
  }
  const row = readHyperneoSession(deps.db(), sessionId);
  if (!row) return reject('not_found', `Session ${sessionId} is gone.`);
  const work = toWork(row, deps.machine);
  return {
    ok: true,
    value: {
      ...work,
      ...(work.status === 'done' ? { status: 'queued' as const } : {}),
      ...(model ? { model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      receipt: { executionId: sessionId, inputId },
    },
  };
}

export async function stopHyperneoWork(
  row: HyperneoSessionRow,
  deps: HyperneoAdapterDeps
): Promise<Result<{ stopped: boolean }>> {
  return {
    ok: true,
    value: { stopped: hyperneoSessionBusy(row) && (await deps.sessions.interrupt(row.id)) },
  };
}

const runHyperneoStart = (superpipe({})('hyperneo-start-work') as PipelineAPI)
  .input(['request', 'context', 'deps'])
  .pipe(requireHyperneoStartConfiguration, ['request', 'deps'], 'result:outcome')
  .pipe((request: StartRequest) => request, 'outcome', 'configured')
  .pipe(selectStartFolder, ['configured', 'deps'], 'result:outcome')
  .pipe(createHyperneoSession, ['outcome', 'configured', 'deps'], 'result:outcome')
  .pipe(confirmHyperneoStart, ['outcome', 'configured', 'deps'], 'result:outcome')
  .pipe(openHyperneoWork, ['outcome', 'configured', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  request: StartRequest,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps
) => Promise<Result<WorkStarted>>;

const runHyperneoStop = (superpipe({})('hyperneo-stop-work') as PipelineAPI)
  .input(['ref', 'deps'])
  .pipe(requireHyperneoSession, ['ref', 'deps'], 'result:outcome')
  .pipe(stopHyperneoWork, ['outcome', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  deps: HyperneoAdapterDeps
) => Promise<Result<{ stopped: boolean }>>;

export async function withHyperneoInputEvidence(
  outcome: Result<WorkDetail>,
  row: HyperneoSessionRow,
  deps: HyperneoAdapterDeps,
  receipt: WorkDelivery['receipt']
): Promise<Result<WorkDetail>> {
  return outcome.ok && receipt
    ? {
        ok: true,
        value: {
          ...outcome.value,
          inputEvidence: await readHyperneoTodoEvidence(deps.db(), row.id, receipt),
        },
      }
    : outcome;
}

const runHyperneoStatus = (superpipe({})('hyperneo-work-status') as PipelineAPI)
  .input(['ref', 'deps', 'since', 'receipt'])
  .pipe(requireHyperneoSession, ['ref', 'deps'], 'result:outcome')
  .pipe((row: HyperneoSessionRow) => row, 'outcome', 'row')
  .pipe(describeHyperneoWork, ['row', 'deps', 'since'], 'outcome')
  .pipe(withHyperneoInputEvidence, ['outcome', 'row', 'deps', 'receipt'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  deps: HyperneoAdapterDeps,
  since?: number,
  receipt?: WorkDelivery['receipt']
) => Promise<Result<WorkDetail>>;

const runHyperneoSend = (superpipe({})('hyperneo-send-work') as PipelineAPI)
  .input(['ref', 'message', 'context', 'deps', 'deliveryMode'])
  .pipe(requireHyperneoSession, ['ref', 'deps'], 'result:outcome')
  .pipe(requireOpenHyperneoSession, 'outcome', 'result:outcome')
  .pipe(deliverToHyperneo, ['outcome', 'message', 'context', 'deps', 'deliveryMode'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps,
  deliveryMode?: MailboxDeliveryMode
) => Promise<Result<WorkDelivery>>;

const runHyperneoWithdraw = (superpipe({})('hyperneo-withdraw-work') as PipelineAPI)
  .input(['ref', 'queuedSubmissionId', 'context', 'deps'])
  .pipe(requireHyperneoSession, ['ref', 'deps'], 'result:outcome')
  .pipe(
    (row: HyperneoSessionRow, id: string, context: WorkCallContext, deps: HyperneoAdapterDeps) =>
      deps.sessions.withdraw!(row.id, id, context.from),
    ['outcome', 'queuedSubmissionId', 'context', 'deps'],
    'outcome'
  )
  .endAsync('outcome') as (
  ref: WorkRef,
  queuedSubmissionId: string,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps
) => Promise<Result<WorkWithdrawal>>;

const runHyperneoRename = (superpipe({})('hyperneo-rename-work') as PipelineAPI)
  .input(['ref', 'title', 'context', 'deps'])
  .pipe(requireHyperneoSession, ['ref', 'deps'], 'result:outcome')
  .pipe(requireOpenHyperneoSession, 'outcome', 'result:outcome')
  .pipe(
    (
      _row: HyperneoSessionRow,
      ref: WorkRef,
      title: string,
      context: WorkCallContext,
      deps: HyperneoAdapterDeps
    ) => deps.sessions.rename!(ref, title, context),
    ['outcome', 'ref', 'title', 'context', 'deps'],
    'outcome'
  )
  .endAsync('outcome') as (
  ref: WorkRef,
  title: string,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps
) => ReturnType<NonNullable<WorkAdapter['rename']>>;

export function createHyperneoAdapter(deps: HyperneoAdapterDeps): WorkAdapter {
  return {
    id: 'hyperneo',
    supportsStartEffort: true,
    supportsStartPreparation: !!deps.prepareExecution,
    capabilities: [
      'find',
      'start',
      'send',
      'queue',
      'status',
      'stop',
      ...(deps.sessions.withdraw ? ['withdraw' as const] : []),
      ...(deps.sessions.rename ? ['rename' as const] : []),
      ...(deps.sessions.archive ? ['archive' as const] : []),
    ],
    find: async (query) =>
      runHyperneoFind(
        query,
        deps,
        query.text && !query.spaceId ? await deps.searchChats(query.text) : []
      ),
    rename: deps.sessions.rename
      ? (ref, title, context) => runHyperneoRename(ref, title, context, deps)
      : undefined,
    start: (request, context) => runHyperneoStart(request, context, deps),
    send: (ref, message, context) => runHyperneoSend(ref, message, context, deps),
    queue: (ref, message, context) => runHyperneoSend(ref, message, context, deps, 'defer'),
    withdraw: deps.sessions.withdraw
      ? (ref, id, context) => runHyperneoWithdraw(ref, id, context, deps)
      : undefined,
    status: async (ref, since, receipt) => runHyperneoStatus(ref, deps, since, receipt),
    stop: async (ref) => runHyperneoStop(ref, deps),
    archive: async (ref, admit) => {
      const check = () => {
        const found = requireHyperneoSession(ref, deps);
        if ('reason' in found) return found.reason;
        return ['running', 'queued', 'needs_you'].includes(
          hyperneoWorkStatus(found.value.status, found.value.processing)
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
