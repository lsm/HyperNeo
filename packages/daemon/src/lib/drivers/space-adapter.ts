import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { hyperneoWorkStatus } from './hyperneo-adapter.ts';
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

const OPEN_TASK = `status IN ('draft', 'open', 'in_progress', 'review', 'approved', 'blocked', 'rate_limited', 'usage_limited')`;
const TASKS_PER_SPACE = 20;
const AGENT_REF = 'agent:';

export interface SpacePlaceRow {
  id: string;
  name: string;
  folder: string;
  open: number;
  openCount: number;
  archivedCount: number;
  lastActiveAt: number;
}

export interface SpaceTaskRow {
  id: string;
  spaceId: string;
  taskNumber: number;
  title: string;
  status: string;
  updatedAt: number;
}

export interface SpaceTaskDetailRow extends SpaceTaskRow {
  spaceName: string;
  result: string | null;
  reportedSummary: string | null;
  blockReason: string | null;
}

export interface SpaceAgentRow {
  id: string;
  spaceId: string;
  handle: string;
  displayName: string;
  sessionId: string | null;
  status: string;
  updatedAt: number;
  processing: string | null;
}

export interface SpaceTaskNode {
  agentName: string;
  workflowNodeId: string;
  agentSessionId: string | null;
}

export interface SpaceTaskControl {
  create(
    spaceId: string,
    title: string,
    description: string,
    caller: OperationCaller
  ): Promise<{ taskId: string } | { reason: string }>;
  cancel(
    taskId: string,
    caller: OperationCaller
  ): Promise<{ cancelled: true } | { reason: string }>;
  message(
    taskId: string,
    node: SpaceTaskNode,
    message: string,
    fromHuman: boolean
  ): Promise<{ delivered: boolean } | { reason: string }>;
  messageAgent(
    agent: Pick<SpaceAgentRow, 'id' | 'spaceId'>,
    message: string,
    context: WorkCallContext
  ): Promise<{ accepted: true } | { reason: string }>;
}

export interface SpaceAdapterDeps {
  db: () => BunDatabase;
  machine: string;
  searchWorkIds: (text: string) => ReadonlySet<string>;
  tasks: SpaceTaskControl;
}

type Gate<Value> = { value: Value } | { reason: Rejected };

export function spaceTaskWorkStatus(status: string): WorkStatus {
  if (status === 'in_progress' || status === 'approved') return 'running';
  if (status === 'review' || status === 'blocked') return 'needs_you';
  if (status === 'done') return 'done';
  if (status === 'cancelled' || status === 'stopped' || status === 'archived') return 'stopped';
  return 'queued';
}

export function readSpacePlaces(db: BunDatabase): SpacePlaceRow[] {
  return db
    .prepare(
      `SELECT s.id, s.name, s.workspace_path AS folder,
         CASE WHEN s.status = 'active' AND s.stopped = 0 THEN 1 ELSE 0 END AS open,
         (SELECT COUNT(*) FROM space_tasks t WHERE t.space_id = s.id AND t.${OPEN_TASK}) AS openCount,
         (SELECT COUNT(*) FROM space_tasks t WHERE t.space_id = s.id AND t.status = 'archived') AS archivedCount,
         MAX(s.updated_at, COALESCE((SELECT MAX(t.updated_at) FROM space_tasks t WHERE t.space_id = s.id), 0)) AS lastActiveAt
         FROM spaces s`
    )
    .all() as SpacePlaceRow[];
}

export function readSpaceTasks(
  db: BunDatabase,
  includeClosed: boolean,
  text: string | undefined,
  matchedIds: ReadonlySet<string>
): SpaceTaskRow[] {
  const pattern = text ? `%${text.toLowerCase().replace(/[\\%_]/g, '\\$&')}%` : null;
  return db
    .prepare(
      `SELECT id, space_id AS spaceId, task_number AS taskNumber, title, status, updated_at AS updatedAt
         FROM space_tasks WHERE space_id IS NOT NULL AND ${OPEN_TASK}
       UNION ALL
       SELECT id, spaceId, taskNumber, title, status, updatedAt FROM (
         SELECT t.id, t.space_id AS spaceId, t.task_number AS taskNumber, t.title, t.status,
           t.updated_at AS updatedAt,
           ROW_NUMBER() OVER (PARTITION BY t.space_id ORDER BY t.updated_at DESC) AS rank
           FROM space_tasks t JOIN spaces s ON s.id = t.space_id
          WHERE ?1 = 1 AND NOT t.${OPEN_TASK}
            AND (?2 IS NULL
              OR lower('#' || t.task_number || ' ' || t.title) LIKE ?2 ESCAPE '\\'
              OR lower(s.name) LIKE ?2 ESCAPE '\\'
              OR t.id IN (SELECT value FROM json_each(?3))))
        WHERE rank <= ${TASKS_PER_SPACE}
       ORDER BY updatedAt DESC`
    )
    .all(includeClosed ? 1 : 0, pattern, JSON.stringify([...matchedIds])) as SpaceTaskRow[];
}

export function spaceAgentWorkStatus(
  agent: Pick<SpaceAgentRow, 'status' | 'processing'>
): WorkStatus {
  if (agent.status === 'archived' || agent.status === 'disabled') return 'stopped';
  if (agent.status === 'paused') return 'needs_you';
  return hyperneoWorkStatus('active', agent.processing);
}

export function readSpaceAgents(
  db: BunDatabase,
  includeClosed: boolean,
  id?: string
): SpaceAgentRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.space_id AS spaceId, a.handle, a.display_name AS displayName, a.status,
         a.session_id AS sessionId,
         a.updated_at AS updatedAt, s.last_active_at AS sessionActiveAt,
         CASE WHEN json_valid(s.processing_state) THEN json_extract(s.processing_state, '$.status') END AS processing
         FROM space_long_horizon_agents a LEFT JOIN sessions s ON s.id = a.session_id
        WHERE (?1 = 1 OR a.status IN ('active', 'paused')) AND (?2 IS NULL OR a.id = ?2)
`
    )
    .all(includeClosed ? 1 : 0, id ?? null) as Array<
    SpaceAgentRow & { sessionActiveAt: string | null }
  >;
  return rows
    .map(({ sessionActiveAt, ...agent }) => {
      const active = sessionActiveAt ? Date.parse(sessionActiveAt) : Number.NaN;
      return Number.isFinite(active) && active > agent.updatedAt
        ? { ...agent, updatedAt: active }
        : agent;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function toAgentWork(agent: SpaceAgentRow, spaceName: string, machine: string): WorkSummary {
  return {
    ref: { adapter: 'space', id: `${AGENT_REF}${agent.id}` },
    title: `@${agent.handle} ${agent.displayName}`,
    place: { machine, spaceId: agent.spaceId, name: spaceName },
    status: spaceAgentWorkStatus(agent),
    lastActivityAt: agent.updatedAt,
    link: `/space/${agent.spaceId}/agent/${agent.handle}`,
  };
}

function toWork(
  task: SpaceTaskRow,
  space: Pick<SpacePlaceRow, 'id' | 'name'>,
  machine: string
): WorkSummary {
  return {
    ref: { adapter: 'space', id: task.id },
    title: `#${task.taskNumber} ${task.title}`,
    place: { machine, spaceId: space.id, name: space.name },
    status: spaceTaskWorkStatus(task.status),
    lastActivityAt: task.updatedAt,
    link: `/space/${space.id}/task/${task.id}`,
  };
}

export function buildSpaceGroups(
  spaces: readonly SpacePlaceRow[],
  tasks: readonly SpaceTaskRow[],
  query: FindQuery,
  deps: Pick<SpaceAdapterDeps, 'machine'>,
  matchedIds: ReadonlySet<string>,
  agents: readonly SpaceAgentRow[] = []
): PlaceGroup[] {
  const text = query.text?.toLowerCase();
  return spaces
    .filter((space) => query.includeClosed || space.open === 1)
    .filter((space) => !query.spaceId || space.id === query.spaceId)
    .filter((space) => !query.folder || space.folder === query.folder)
    .flatMap((space) => {
      const placeMatches = !text || space.name.toLowerCase().includes(text);
      const work = tasks
        .filter((task) => task.spaceId === space.id)
        .filter(
          (task) =>
            placeMatches ||
            matchedIds.has(task.id) ||
            `#${task.taskNumber} ${task.title}`.toLowerCase().includes(text ?? '')
        )
        .slice(0, TASKS_PER_SPACE)
        .map((task) => toWork(task, space, deps.machine));
      work.unshift(
        ...agents
          .filter((agent) => agent.spaceId === space.id)
          .filter(
            (agent) =>
              placeMatches ||
              (agent.sessionId !== null && matchedIds.has(agent.sessionId)) ||
              `@${agent.handle} ${agent.displayName}`.toLowerCase().includes(text ?? '')
          )
          .map((agent) => toAgentWork(agent, space.name, deps.machine))
      );
      if (!placeMatches && work.length === 0) return [];
      return [
        {
          place: { machine: deps.machine, spaceId: space.id, name: space.name },
          lastActivityAt: space.lastActiveAt,
          openCount: space.openCount,
          archivedCount: space.archivedCount,
          adapters: ['space'],
          work,
        },
      ];
    });
}

export function loadSpacePlaces(deps: SpaceAdapterDeps): SpacePlaceRow[] {
  return readSpacePlaces(deps.db());
}

export function loadSpaceTasks(
  query: FindQuery,
  deps: SpaceAdapterDeps,
  matchedIds: ReadonlySet<string>
): SpaceTaskRow[] {
  return readSpaceTasks(deps.db(), query.includeClosed, query.text, matchedIds);
}

export function matchSpaceTasks(query: FindQuery, deps: SpaceAdapterDeps): ReadonlySet<string> {
  return query.text ? deps.searchWorkIds(query.text) : new Set();
}

export function loadSpaceAgents(query: FindQuery, deps: SpaceAdapterDeps): SpaceAgentRow[] {
  return readSpaceAgents(deps.db(), query.includeClosed);
}

const runSpaceFind = (superpipe({})('space-find-work') as PipelineAPI)
  .input(['query', 'deps'])
  .pipe(loadSpacePlaces, 'deps', 'spaces')
  .pipe(matchSpaceTasks, ['query', 'deps'], 'matchedIds')
  .pipe(loadSpaceTasks, ['query', 'deps', 'matchedIds'], 'tasks')
  .pipe(loadSpaceAgents, ['query', 'deps'], 'agents')
  .pipe(buildSpaceGroups, ['spaces', 'tasks', 'query', 'deps', 'matchedIds', 'agents'], 'groups')
  .end('groups') as (query: FindQuery, deps: SpaceAdapterDeps) => PlaceGroup[];

export function spaceTaskCaller(caller: OperationCaller): OperationCaller {
  return caller.role === 'neo' ? { ...caller, source: 'internal' } : caller;
}

export function taskOperationRejection(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return 'No task came back.';
  const record = value as { accepted?: unknown; reason?: unknown; detail?: unknown };
  if (record.accepted !== false && typeof record.reason !== 'string') return null;
  return [record.reason, record.detail].filter((part) => typeof part === 'string').join(': ');
}

export function readSpaceTask(db: BunDatabase, id: string): SpaceTaskDetailRow | null {
  const row = db
    .prepare(
      `SELECT t.id, t.space_id AS spaceId, t.task_number AS taskNumber, t.title, t.status,
         t.updated_at AS updatedAt, t.result, t.reported_summary AS reportedSummary,
         t.block_reason AS blockReason, s.name AS spaceName
         FROM space_tasks t JOIN spaces s ON s.id = t.space_id WHERE t.id = ?`
    )
    .get(id) as SpaceTaskDetailRow | null | undefined;
  return row ?? null;
}

function describeTask(task: SpaceTaskDetailRow, machine: string): WorkDetail {
  const work = toWork(task, { id: task.spaceId, name: task.spaceName }, machine);
  const lastReply = task.result ?? task.reportedSummary ?? task.blockReason;
  return lastReply ? { ...work, lastReply } : work;
}

export function requireSpaceTask(ref: WorkRef, deps: SpaceAdapterDeps): Gate<SpaceTaskDetailRow> {
  const task = readSpaceTask(deps.db(), ref.id);
  return task ? { value: task } : { reason: reject('not_found', `No Space task ${ref.id}.`) };
}

export function reportSpaceTask(
  task: SpaceTaskDetailRow,
  deps: SpaceAdapterDeps
): Result<WorkDetail> {
  return { ok: true, value: describeTask(task, deps.machine) };
}

export function requireTaskSpace(request: StartRequest, deps: SpaceAdapterDeps): Gate<string> {
  const { place } = request;
  if (!place.spaceId)
    return { reason: reject('invalid_place', 'Name a Space to start a task in.') };
  return place.machine === deps.machine
    ? { value: place.spaceId }
    : { reason: reject('invalid_place', `${place.name} is on ${place.machine}, not here.`) };
}

export async function createSpaceTask(
  spaceId: string,
  request: StartRequest,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
): Promise<Result<WorkSummary>> {
  const created = await deps.tasks.create(spaceId, request.title, request.message, context.caller);
  if ('reason' in created) return reject('invalid_place', created.reason);
  const task = readSpaceTask(deps.db(), created.taskId);
  return task
    ? { ok: true, value: describeTask(task, deps.machine) }
    : reject('not_found', `Task ${created.taskId} is gone.`);
}

export async function cancelSpaceTask(
  task: SpaceTaskDetailRow,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
): Promise<Result<{ stopped: boolean }>> {
  const status = spaceTaskWorkStatus(task.status);
  if (task.status === 'draft' || status === 'done' || status === 'stopped') {
    return { ok: true, value: { stopped: false } };
  }
  const cancelled = await deps.tasks.cancel(task.id, context.caller);
  return 'reason' in cancelled
    ? reject('not_delivered', cancelled.reason)
    : { ok: true, value: { stopped: true } };
}

const runSpaceStart = (superpipe({})('space-start-work') as PipelineAPI)
  .input(['request', 'context', 'deps'])
  .pipe(requireTaskSpace, ['request', 'deps'], 'result:outcome')
  .pipe(createSpaceTask, ['outcome', 'request', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  request: StartRequest,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
) => Promise<Result<WorkSummary>>;

export function requireTaskMessenger(
  task: SpaceTaskDetailRow,
  context: WorkCallContext
): Gate<SpaceTaskDetailRow> {
  const { caller } = context;
  if (caller.source === 'mcp' && caller.role !== 'neo') {
    return {
      reason: reject('unsupported', 'Agents message Space tasks with task.message.send.'),
    };
  }
  const status = spaceTaskWorkStatus(task.status);
  return status === 'done' || status === 'stopped'
    ? { reason: reject('not_open', `Task #${task.taskNumber} is ${task.status}.`) }
    : { value: task };
}

export function readActiveNode(db: BunDatabase, taskId: string): SpaceTaskNode | null {
  const row = db
    .prepare(
      `SELECT n.agent_name AS agentName, n.workflow_node_id AS workflowNodeId,
              n.agent_session_id AS agentSessionId FROM node_executions n
         JOIN space_tasks t ON t.workflow_run_id = n.workflow_run_id
        WHERE t.id = ?
          AND n.status IN ('in_progress', 'blocked', 'idle', 'waiting_rebind')
        ORDER BY COALESCE(n.last_activity_at, n.updated_at) DESC
        LIMIT 1`
    )
    .get(taskId) as SpaceTaskNode | null | undefined;
  return row ?? null;
}

export async function messageSpaceTask(
  task: SpaceTaskDetailRow,
  message: string,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
): Promise<Result<{ delivered: boolean }>> {
  const node = readActiveNode(deps.db(), task.id);
  if (!node) {
    return reject(
      'unsupported',
      `Task #${task.taskNumber} has no workflow agent working on it to message.`
    );
  }
  const sent = await deps.tasks.message(task.id, node, message, context.from === 'chat');
  return 'reason' in sent
    ? reject('not_delivered', sent.reason)
    : { ok: true, value: { delivered: sent.delivered } };
}

const runSpaceSend = (superpipe({})('space-send-work') as PipelineAPI)
  .input(['ref', 'message', 'context', 'deps'])
  .pipe(requireSpaceTask, ['ref', 'deps'], 'result:outcome')
  .pipe(requireTaskMessenger, ['outcome', 'context'], 'result:outcome')
  .pipe(messageSpaceTask, ['outcome', 'message', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
) => Promise<Result<{ delivered: boolean }>>;

export function reportSpaceAgent(ref: WorkRef, deps: SpaceAdapterDeps): Result<WorkDetail> | null {
  if (!ref.id.startsWith(AGENT_REF)) return null;
  const agent = readSpaceAgents(deps.db(), true, ref.id.slice(AGENT_REF.length))[0];
  if (!agent) return reject('not_found', `No Space agent ${ref.id}.`);
  const space = deps.db().prepare('SELECT name FROM spaces WHERE id = ?').get(agent.spaceId) as
    | { name: string }
    | null
    | undefined;
  return { ok: true, value: toAgentWork(agent, space?.name ?? agent.spaceId, deps.machine) };
}

const runSpaceStatus = (superpipe({})('space-work-status') as PipelineAPI)
  .input(['ref', 'deps'])
  .pipe(requireSpaceTask, ['ref', 'deps'], 'result:outcome')
  .pipe(reportSpaceTask, ['outcome', 'deps'], 'outcome')
  .end('outcome') as (ref: WorkRef, deps: SpaceAdapterDeps) => Result<WorkDetail>;

const runSpaceStop = (superpipe({})('space-stop-work') as PipelineAPI)
  .input(['ref', 'context', 'deps'])
  .pipe(requireSpaceTask, ['ref', 'deps'], 'result:outcome')
  .pipe(cancelSpaceTask, ['outcome', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
) => Promise<Result<{ stopped: boolean }>>;

export function requireSpaceAgentRecipient(
  ref: WorkRef,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
): Gate<SpaceAgentRow> {
  const agent = readSpaceAgents(deps.db(), true, ref.id.slice(AGENT_REF.length))[0];
  if (!agent) return { reason: reject('not_found', `No Space agent ${ref.id}.`) };
  if (context.caller.source === 'mcp' && context.caller.role !== 'neo') {
    return { reason: reject('unsupported', 'Agents message Space agents with message.send.') };
  }
  return agent.status === 'archived' || agent.status === 'disabled'
    ? { reason: reject('not_open', `@${agent.handle} is ${agent.status}.`) }
    : { value: agent };
}

export async function messageSpaceAgent(
  agent: SpaceAgentRow,
  message: string,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
): Promise<Result<{ delivered: boolean }>> {
  const sent = await deps.tasks.messageAgent(agent, message, context);
  return 'reason' in sent
    ? reject('not_delivered', sent.reason)
    : { ok: true, value: { delivered: spaceAgentWorkStatus(agent) === 'done' } };
}

const runSpaceAgentSend = (superpipe({})('space-agent-send-work') as PipelineAPI)
  .input(['ref', 'message', 'context', 'deps'])
  .pipe(requireSpaceAgentRecipient, ['ref', 'context', 'deps'], 'result:outcome')
  .pipe(messageSpaceAgent, ['outcome', 'message', 'context', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  message: string,
  context: WorkCallContext,
  deps: SpaceAdapterDeps
) => Promise<Result<{ delivered: boolean }>>;

export function createSpaceAdapter(deps: SpaceAdapterDeps): WorkAdapter {
  return {
    id: 'space',
    capabilities: ['find', 'start', 'send', 'status', 'stop'],
    find: (query) => runSpaceFind(query, deps),
    start: (request, context) => runSpaceStart(request, context, deps),
    send: (ref, message, context) =>
      ref.id.startsWith(AGENT_REF)
        ? runSpaceAgentSend(ref, message, context, deps)
        : runSpaceSend(ref, message, context, deps),
    status: async (ref) => reportSpaceAgent(ref, deps) ?? runSpaceStatus(ref, deps),
    stop: (ref, context) => runSpaceStop(ref, context, deps),
  };
}
