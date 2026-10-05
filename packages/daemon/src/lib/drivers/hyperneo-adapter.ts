import { basename } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { MailboxHandoffOutcome } from '../mailbox/handoff.ts';
import { sessionUnavailable } from '../session-resolution/session-lookup.ts';
import type {
  FindQuery,
  PlaceGroup,
  Rejected,
  Result,
  StartRequest,
  WorkAdapter,
  WorkCallContext,
  WorkDetail,
  WorkRef,
  WorkStatus,
  WorkSummary,
} from './types.ts';
import { reject } from './work-operations.ts';

const OPEN = `status IN ('active', 'paused', 'pending_worktree_choice')`;
const OWN_SESSIONS = `space_id IS NULL AND room_id IS NULL AND id NOT LIKE 'neo:%' AND type IN ('worker', 'general')`;
const FOLDER = 'COALESCE(main_repo_path, workspace_path)';
const PROCESSING = `CASE WHEN json_valid(processing_state) THEN json_extract(processing_state, '$.status') END`;
const SESSION_COLUMNS = `id, title, status, ${FOLDER} AS folder, last_active_at AS lastActiveAt,
  ${PROCESSING} AS processing`;
const SESSIONS_PER_PLACE = 20;
const CLOSED_SESSIONS = 500;
const REPLY_LIMIT = 4_000;

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
}

export interface HyperneoSessionControl {
  create(workspacePath: string, title: string): Promise<string>;
  chooseWorktree(sessionId: string): Promise<void>;
  announce(sessionId: string): void;
  interrupt(sessionId: string): boolean;
}

export interface HyperneoAdapterDeps {
  db: () => BunDatabase;
  machine: string;
  searchSessionIds: (text: string) => ReadonlySet<string>;
  handoff: (sessionId: string, message: string, from: string) => Promise<MailboxHandoffOutcome>;
  sessions: HyperneoSessionControl;
  neoFolder: () => string;
  folderExists: (folder: string) => boolean;
}

export interface HyperneoLastResult {
  reply: string | null;
  failed: number | null;
}

type Gate<Value> = { value: Value } | { reason: Rejected };

export function hyperneoWorkStatus(status: string, processing: string | null): WorkStatus {
  if (status === 'archived' || status === 'ended' || processing === 'interrupted') return 'stopped';
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
  matchedIds: ReadonlySet<string>
): PlaceGroup[] {
  const machine = deps.machine;
  const text = query.text?.toLowerCase();
  return places
    .filter((place) => !query.folder || place.folder === query.folder)
    .filter((place) => query.includeClosed || place.openCount > 0 || place.known > 0)
    .flatMap((place) => {
      const placeMatches =
        !text || `${placeName(place.folder)} ${place.folder ?? ''}`.toLowerCase().includes(text);
      const work = sessions
        .filter((session) => session.folder === place.folder)
        .filter(
          (session) =>
            placeMatches ||
            matchedIds.has(session.id) ||
            session.title.toLowerCase().includes(text ?? '')
        )
        .slice(0, SESSIONS_PER_PLACE)
        .map((session) => toWork(session, machine));
      if (!placeMatches && work.length === 0) return [];
      return [
        {
          place: {
            machine,
            ...(place.folder ? { folder: place.folder } : {}),
            name: placeName(place.folder),
          },
          lastActivityAt: timestamp(place.lastActiveAt),
          openCount: place.openCount,
          archivedCount: place.archivedCount,
          adapters: ['hyperneo'],
          work,
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
  query: FindQuery,
  deps: HyperneoAdapterDeps
): ReadonlySet<string> {
  return query.text ? deps.searchSessionIds(query.text) : new Set();
}

export function skipSpaceQuery(query: FindQuery): { value: FindQuery } | { reason: PlaceGroup[] } {
  return query.spaceId ? { reason: [] } : { value: query };
}

const runHyperneoFind = (superpipe({})('hyperneo-find-work') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(skipSpaceQuery, 'query', 'result:groups')
  .pipe(loadHyperneoPlaces, 'deps', 'places')
  .pipe(loadHyperneoSessions, ['query', 'deps'], 'sessions')
  .pipe(matchHyperneoSessions, ['query', 'deps'], 'matchedIds')
  .pipe(buildHyperneoGroups, ['places', 'sessions', 'query', 'deps', 'matchedIds'], 'groups')
  .end('groups') as (query: FindQuery, deps: HyperneoAdapterDeps) => PlaceGroup[];

export function hyperneoSessionBusy(row: HyperneoSessionRow): boolean {
  const status = hyperneoWorkStatus(row.status, row.processing);
  return status === 'running' || status === 'queued';
}

export function readHyperneoSession(db: BunDatabase, id: string): HyperneoSessionRow | null {
  const row = db
    .prepare(
      `SELECT id, title, status, ${FOLDER} AS folder, last_active_at AS lastActiveAt,
         ${PROCESSING} AS processing FROM sessions WHERE id = ? AND ${OWN_SESSIONS}`
    )
    .get(id) as HyperneoSessionRow | null | undefined;
  return row ?? null;
}

export function readHyperneoLastResult(db: BunDatabase, id: string): HyperneoLastResult | null {
  const row = db
    .prepare(
      `SELECT json_extract(sdk_message, '$.result') AS reply, json_extract(sdk_message, '$.is_error') AS failed
         FROM sdk_messages WHERE session_id = ? AND message_type = 'result' AND parent_tool_use_id IS NULL
          AND COALESCE(json_extract(sdk_message, '$.internal_compaction_turn'), 0) = 0
        ORDER BY timestamp DESC LIMIT 1`
    )
    .get(id) as HyperneoLastResult | null | undefined;
  return row ?? null;
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
  deps: HyperneoAdapterDeps
): Result<WorkDetail> {
  const work = toWork(row, deps.machine);
  const last = readHyperneoLastResult(deps.db(), row.id);
  return {
    ok: true,
    value: {
      ...work,
      status: work.status === 'done' && last?.failed ? 'failed' : work.status,
      ...(last?.reply ? { lastReply: last.reply.slice(0, REPLY_LIMIT) } : {}),
    },
  };
}

export async function deliverToHyperneo(
  row: HyperneoSessionRow,
  message: string,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps
): Promise<Result<{ delivered: boolean }>> {
  const outcome = await deps.handoff(row.id, message, context.from);
  if (outcome.kind === 'rejected') return reject('not_delivered', outcome.reason);
  return { ok: true, value: { delivered: !hyperneoSessionBusy(row) } };
}

export function selectStartFolder(request: StartRequest, deps: HyperneoAdapterDeps): Gate<string> {
  const { place } = request;
  if (place.spaceId) {
    return { reason: reject('invalid_place', 'Spaces take work through the space adapter.') };
  }
  if (place.machine !== deps.machine) {
    return { reason: reject('invalid_place', `${place.name} is on ${place.machine}, not here.`) };
  }
  if (!place.folder) return { value: deps.neoFolder() };
  return deps.folderExists(place.folder)
    ? { value: place.folder }
    : { reason: reject('invalid_place', `${place.folder} does not exist.`) };
}

export async function createHyperneoSession(
  folder: string,
  request: StartRequest,
  deps: HyperneoAdapterDeps
): Promise<string> {
  const sessionId = await deps.sessions.create(folder, request.title);
  if (readHyperneoSession(deps.db(), sessionId)?.status === 'pending_worktree_choice') {
    await deps.sessions.chooseWorktree(sessionId);
  }
  deps.sessions.announce(sessionId);
  return sessionId;
}

export async function openHyperneoWork(
  sessionId: string,
  request: StartRequest,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps
): Promise<Result<WorkSummary>> {
  const outcome = await deps.handoff(sessionId, request.message, context.from);
  if (outcome.kind === 'rejected') {
    return reject(
      'not_delivered',
      `Session ${sessionId} started without its message: ${outcome.reason}`
    );
  }
  const row = readHyperneoSession(deps.db(), sessionId);
  if (!row) return reject('not_found', `Session ${sessionId} is gone.`);
  const work = toWork(row, deps.machine);
  return { ok: true, value: work.status === 'done' ? { ...work, status: 'queued' } : work };
}

export function stopHyperneoWork(
  row: HyperneoSessionRow,
  deps: HyperneoAdapterDeps
): Result<{ stopped: boolean }> {
  return {
    ok: true,
    value: { stopped: hyperneoSessionBusy(row) && deps.sessions.interrupt(row.id) },
  };
}

const runHyperneoStart = (superpipe({})('hyperneo-start-work') as PipelineAPI)
  .input(['request', 'context', 'deps'])
  .pipe(selectStartFolder, ['request', 'deps'], 'result:outcome')
  .pipe(createHyperneoSession, ['outcome', 'request', 'deps'], 'sessionId')
  .pipe(openHyperneoWork, ['sessionId', 'request', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  request: StartRequest,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps
) => Promise<Result<WorkSummary>>;

const runHyperneoStop = (superpipe({})('hyperneo-stop-work') as PipelineAPI)
  .input(['ref', 'deps'])
  .pipe(requireHyperneoSession, ['ref', 'deps'], 'result:outcome')
  .pipe(stopHyperneoWork, ['outcome', 'deps'], 'outcome')
  .end('outcome') as (ref: WorkRef, deps: HyperneoAdapterDeps) => Result<{ stopped: boolean }>;

const runHyperneoStatus = (superpipe({})('hyperneo-work-status') as PipelineAPI)
  .input(['ref', 'deps'])
  .pipe(requireHyperneoSession, ['ref', 'deps'], 'result:outcome')
  .pipe(describeHyperneoWork, ['outcome', 'deps'], 'outcome')
  .end('outcome') as (ref: WorkRef, deps: HyperneoAdapterDeps) => Result<WorkDetail>;

const runHyperneoSend = (superpipe({})('hyperneo-send-work') as PipelineAPI)
  .input(['ref', 'message', 'context', 'deps'])
  .pipe(requireHyperneoSession, ['ref', 'deps'], 'result:outcome')
  .pipe(requireOpenHyperneoSession, 'outcome', 'result:outcome')
  .pipe(deliverToHyperneo, ['outcome', 'message', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  context: WorkCallContext,
  deps: HyperneoAdapterDeps
) => Promise<Result<{ delivered: boolean }>>;

export function createHyperneoAdapter(deps: HyperneoAdapterDeps): WorkAdapter {
  return {
    id: 'hyperneo',
    capabilities: ['find', 'start', 'send', 'status', 'stop'],
    find: (query) => runHyperneoFind(query, deps),
    start: (request, context) => runHyperneoStart(request, context, deps),
    send: (ref, message, context) => runHyperneoSend(ref, message, context, deps),
    status: async (ref) => runHyperneoStatus(ref, deps),
    stop: async (ref) => runHyperneoStop(ref, deps),
  };
}
