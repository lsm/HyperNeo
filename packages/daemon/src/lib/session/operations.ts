import type { Session } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import type { AgentSession } from '../agent/agent-session.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationCallerRole,
  type OperationDefinition,
  type OperationPolicy,
} from '../operations/registry.ts';
import {
  admitSpaceCaller,
  type SpaceCallerAdmission,
  type SpaceCallerRejection,
} from '../operations/space-caller-admission.ts';
import {
  getSpaceSessionRow,
  listSessionMessages,
  listSpaceSessionRows,
  parseJsonValue,
  parseProcessingState,
  rowToSessionSummary,
  SESSION_DETAIL_MESSAGE_LIMIT,
  SESSION_MESSAGE_LIMIT_DEFAULT,
  SESSION_MESSAGE_LIMIT_MAX,
  SPACE_SESSION_LIMIT_DEFAULT,
  SPACE_SESSION_LIMIT_MAX,
  type SpaceSessionMessage,
  type SpaceSessionRow,
  type SpaceSessionSummary,
} from './space-session-reads.ts';

export interface SessionAuditEntry {
  readonly toolName: string;
  readonly spaceId: string;
  readonly caller: OperationCaller;
  readonly paramsSummary: Record<string, unknown>;
}

export interface SessionOperationDependencies {
  readonly getDatabase: () => BunDatabase;
  readonly getLiveSession: (sessionId: string) => AgentSession | null;
  readonly getSession: (sessionId: string) => Session | null;
  readonly sessionSpaceId: (session: Session) => string | undefined;
  readonly audit?: (entry: SessionAuditEntry) => void;
}

const ProcessingStateSchema = z.record(z.string(), z.unknown());

const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  type: z.enum(['worker', 'ad-hoc']),
  processing_state: ProcessingStateSchema,
  created_at: z.string(),
  last_active_at: z.string(),
  is_worktree: z.boolean(),
  git_branch: z.string().nullable(),
  workspace_path: z.string().nullable(),
}) satisfies z.ZodType<SpaceSessionSummary>;

const SessionMessageSchema = z.object({
  id: z.string(),
  message_type: z.string(),
  message_subtype: z.string().nullable(),
  is_terminal: z.boolean(),
  timestamp: z.string(),
  cursor: z.string(),
  content_summary: z.string(),
}) satisfies z.ZodType<SpaceSessionMessage>;

const SessionDetailSchema = SessionSummarySchema.extend({
  raw_status: z.string(),
  metadata: ProcessingStateSchema.nullable(),
  session_context: ProcessingStateSchema.nullable(),
  last_messages: z.array(SessionMessageSchema),
});

const SessionRejectionSchema = z.object({
  ok: z.literal(false),
  reason: z.enum([
    'space_scope_required',
    'space_mismatch',
    'denied',
    'session_not_found',
    'session_archived',
    'live_session_present',
    'live_session_required',
    'invalid_state',
    'rejected',
  ]),
  message: z.string(),
});

const SessionListResultSchema = z.union([
  z.object({ ok: z.literal(true), sessions: z.array(SessionSummarySchema) }),
  SessionRejectionSchema,
]);
const SessionDetailResultSchema = z.union([
  z.object({ ok: z.literal(true), session: SessionDetailSchema }),
  SessionRejectionSchema,
]);
const SessionMessagesResultSchema = z.union([
  z.object({ ok: z.literal(true), messages: z.array(SessionMessageSchema) }),
  SessionRejectionSchema,
]);
const SessionStateResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    previous_state: ProcessingStateSchema,
    new_state: ProcessingStateSchema,
  }),
  SessionRejectionSchema,
]);
const SessionInterruptResultSchema = z.union([
  z.object({ ok: z.literal(true), interrupted: z.literal(true) }),
  SessionRejectionSchema,
]);

type SessionRejection = z.infer<typeof SessionRejectionSchema>;
type SessionListResult = z.infer<typeof SessionListResultSchema>;
type SessionDetailResult = z.infer<typeof SessionDetailResultSchema>;
type SessionMessagesResult = z.infer<typeof SessionMessagesResultSchema>;
type SessionStateResult = z.infer<typeof SessionStateResultSchema>;
type SessionInterruptResult = z.infer<typeof SessionInterruptResultSchema>;

const SpaceScopeSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Space to act in. Ignored for agents, whose Space comes from their session.');

const ListSessionsInputSchema = z
  .object({
    spaceId: SpaceScopeSchema,
    status: z.enum(['active', 'idle', 'waiting_for_input', 'error', 'archived']).optional(),
    type: z.enum(['worker', 'ad-hoc']).optional(),
    limit: z.number().int().positive().max(SPACE_SESSION_LIMIT_MAX).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

const SessionRefInputSchema = z
  .object({ spaceId: SpaceScopeSchema, sessionId: z.string().min(1) })
  .strict();

const SessionMessagesInputSchema = z
  .object({
    spaceId: SpaceScopeSchema,
    sessionId: z.string().min(1),
    limit: z.number().int().positive().max(SESSION_MESSAGE_LIMIT_MAX).optional(),
    before: z.string().min(1).optional(),
  })
  .strict();

const UpdateSessionStateInputSchema = z
  .object({
    spaceId: SpaceScopeSchema,
    sessionId: z.string().min(1),
    processingState: z.enum(['idle', 'running', 'waiting_for_input']),
    clearPendingQuestion: z.boolean().optional(),
  })
  .strict();

const InterruptSessionInputSchema = z
  .object({
    spaceId: SpaceScopeSchema,
    sessionId: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict();

type ListSessionsInput = z.infer<typeof ListSessionsInputSchema>;
type SessionRefInput = z.infer<typeof SessionRefInputSchema>;
type SessionMessagesInput = z.infer<typeof SessionMessagesInputSchema>;
type UpdateSessionStateInput = z.infer<typeof UpdateSessionStateInputSchema>;
type InterruptSessionInput = z.infer<typeof InterruptSessionInputSchema>;

const SCOPE_MESSAGES: Record<SpaceCallerRejection, string> = {
  space_scope_required: 'A Space is required: pass spaceId, or call from a session inside a Space.',
  space_mismatch: 'The requested spaceId does not match the calling session Space.',
  denied: 'This caller may not use Space sessions.',
};

function reject(reason: SessionRejection['reason'], message: string): SessionRejection {
  return { ok: false, reason, message };
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function auditSpaceId(caller: OperationCaller, input: { spaceId?: string }): string {
  return caller.spaceId ?? input.spaceId ?? '';
}

function recordSessionAudit(deps: SessionOperationDependencies, entry: SessionAuditEntry): void {
  try {
    deps.audit?.(entry);
  } catch {}
}

function asRecord(value: string | null | undefined): Record<string, unknown> | null {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

export function resolveSessionScope(
  input: { spaceId?: string },
  caller: OperationCaller,
  deps: SessionOperationDependencies,
  admission: SpaceCallerAdmission
): { value: string } | { reason: SessionRejection } {
  const scope = admitSpaceCaller(caller, input.spaceId, {
    ...admission,
    getSession: deps.getSession,
    sessionSpaceId: deps.sessionSpaceId,
  });
  return 'value' in scope ? scope : { reason: reject(scope.reason, SCOPE_MESSAGES[scope.reason]) };
}

export function requireSpaceSessionRow(
  spaceId: string,
  input: { sessionId: string },
  deps: SessionOperationDependencies
): { value: SpaceSessionRow } | { reason: SessionRejection } {
  const row = getSpaceSessionRow(deps.getDatabase(), spaceId, input.sessionId);
  return row
    ? { value: row }
    : {
        reason: reject('session_not_found', `Session not found in this space: ${input.sessionId}`),
      };
}

export function requireMutableSpaceSessionRow(
  spaceId: string,
  input: { sessionId: string },
  deps: SessionOperationDependencies
): { value: SpaceSessionRow } | { reason: SessionRejection } {
  const outcome = requireSpaceSessionRow(spaceId, input, deps);
  if ('reason' in outcome) return outcome;
  return outcome.value.status === 'archived'
    ? { reason: reject('session_archived', `Session is archived: ${input.sessionId}`) }
    : outcome;
}

export function listSpaceSessions(
  spaceId: string,
  input: ListSessionsInput,
  deps: SessionOperationDependencies
): SessionListResult {
  try {
    const limit = Math.min(input.limit ?? SPACE_SESSION_LIMIT_DEFAULT, SPACE_SESSION_LIMIT_MAX);
    const offset = Math.max(input.offset ?? 0, 0);
    const rows = listSpaceSessionRows(
      deps.getDatabase(),
      spaceId,
      { status: input.status, type: input.type },
      limit,
      offset
    );
    return { ok: true, sessions: rows.map(rowToSessionSummary) };
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
}

export function readSessionDetail(
  row: SpaceSessionRow,
  deps: SessionOperationDependencies
): SessionDetailResult {
  try {
    return {
      ok: true,
      session: {
        ...rowToSessionSummary(row),
        raw_status: row.status,
        metadata: asRecord(row.metadata),
        session_context: asRecord(row.session_context),
        last_messages: listSessionMessages(
          deps.getDatabase(),
          row.id,
          SESSION_DETAIL_MESSAGE_LIMIT
        ),
      },
    };
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
}

export function readSessionMessages(
  row: SpaceSessionRow,
  input: SessionMessagesInput,
  deps: SessionOperationDependencies
): SessionMessagesResult {
  try {
    return {
      ok: true,
      messages: listSessionMessages(
        deps.getDatabase(),
        row.id,
        input.limit ?? SESSION_MESSAGE_LIMIT_DEFAULT,
        input.before
      ),
    };
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
}

export function applySessionState(
  row: SpaceSessionRow,
  input: UpdateSessionStateInput,
  caller: OperationCaller,
  deps: SessionOperationDependencies
): SessionStateResult {
  if (deps.getLiveSession(input.sessionId)) {
    return reject(
      'live_session_present',
      'session.state.update cannot mutate live sessions. Interrupt or message the live session instead.'
    );
  }
  const previousState = parseProcessingState(row.processing_state);
  const newStatus = input.processingState === 'running' ? 'processing' : input.processingState;
  const newState: Record<string, unknown> = { ...previousState, status: newStatus };
  if (input.clearPendingQuestion || input.processingState !== 'waiting_for_input') {
    delete newState.pendingQuestion;
  }
  if (input.processingState === 'waiting_for_input' && !newState.pendingQuestion) {
    return reject(
      'invalid_state',
      'Cannot set waiting_for_input without an existing pending question'
    );
  }
  try {
    deps
      .getDatabase()
      .prepare(`UPDATE sessions SET processing_state = ?, last_active_at = ? WHERE id = ?`)
      .run(JSON.stringify(newState), new Date().toISOString(), input.sessionId);
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
  recordSessionAudit(deps, {
    toolName: 'session.state.update',
    spaceId: auditSpaceId(caller, input),
    caller,
    paramsSummary: {
      session_id: input.sessionId,
      processing_state: input.processingState,
      clear_pending_question: input.clearPendingQuestion ?? false,
    },
  });
  return { ok: true, previous_state: previousState, new_state: newState };
}

export async function interruptSpaceSession(
  input: InterruptSessionInput,
  caller: OperationCaller,
  deps: SessionOperationDependencies
): Promise<SessionInterruptResult> {
  const liveSession = deps.getLiveSession(input.sessionId);
  if (!liveSession) {
    return reject(
      'live_session_required',
      'session.interrupt requires a live cached session. Use session.state.update for cold session recovery.'
    );
  }
  try {
    await liveSession.handleInterrupt();
  } catch (err) {
    return reject('rejected', failureMessage(err));
  }
  recordSessionAudit(deps, {
    toolName: 'session.interrupt',
    spaceId: auditSpaceId(caller, input),
    caller,
    paramsSummary: { session_id: input.sessionId, reason: input.reason },
  });
  return { ok: true, interrupted: true };
}

const READ_ADMISSION: SpaceCallerAdmission = { readOnly: true, workerAllowed: true };
const WRITE_ADMISSION: SpaceCallerAdmission = { readOnly: false };

const READ_ROLES: readonly OperationCallerRole[] = [
  'ad_hoc_member',
  'long_term_agent',
  'universal_read',
  'workflow_worker',
];
const WRITE_ROLES: readonly OperationCallerRole[] = ['ad_hoc_member', 'long_term_agent'];

const READ_POLICY: OperationPolicy = { safetyClass: 'read', roles: READ_ROLES };
const MUTATE_POLICY: OperationPolicy = { safetyClass: 'mutate', roles: WRITE_ROLES };
const DESTRUCTIVE_POLICY: OperationPolicy = { safetyClass: 'destructive', roles: WRITE_ROLES };

const SCOPE_NOTE =
  'Human (RPC) callers pass spaceId; agent (MCP) callers inherit the Space of their own session and may not override it.';

function sessionPipeline<Input, Result>(
  label: string,
  injected: Record<string, unknown>,
  stages: (pipeline: PipelineAPI) => PipelineAPI
): (input: Input, caller: OperationCaller) => Promise<Result> {
  const scoped = (superpipe(injected)(label) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(resolveSessionScope, ['input', 'caller', 'deps', 'admission'], 'result:outcome');
  return stages(scoped).endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<Result>;
}

export function createSessionOperations(deps: SessionOperationDependencies): OperationDefinition[] {
  const read = { deps, admission: READ_ADMISSION };
  const write = { deps, admission: WRITE_ADMISSION };

  const list = sessionPipeline<ListSessionsInput, SessionListResult>(
    'session-list',
    read,
    (pipeline) => pipeline.pipe(listSpaceSessions, ['outcome', 'input', 'deps'], 'outcome')
  );
  const detail = sessionPipeline<SessionRefInput, SessionDetailResult>(
    'session-get',
    read,
    (pipeline) =>
      pipeline
        .pipe(requireSpaceSessionRow, ['outcome', 'input', 'deps'], 'result:outcome')
        .pipe(readSessionDetail, ['outcome', 'deps'], 'outcome')
  );
  const messages = sessionPipeline<SessionMessagesInput, SessionMessagesResult>(
    'session-messages-list',
    read,
    (pipeline) =>
      pipeline
        .pipe(requireSpaceSessionRow, ['outcome', 'input', 'deps'], 'result:outcome')
        .pipe(readSessionMessages, ['outcome', 'input', 'deps'], 'outcome')
  );
  const updateState = sessionPipeline<UpdateSessionStateInput, SessionStateResult>(
    'session-state-update',
    write,
    (pipeline) =>
      pipeline
        .pipe(requireMutableSpaceSessionRow, ['outcome', 'input', 'deps'], 'result:outcome')
        .pipe(applySessionState, ['outcome', 'input', 'caller', 'deps'], 'outcome')
  );
  const interrupt = sessionPipeline<InterruptSessionInput, SessionInterruptResult>(
    'session-interrupt',
    write,
    (pipeline) =>
      pipeline
        .pipe(requireMutableSpaceSessionRow, ['outcome', 'input', 'deps'], 'result:outcome')
        .pipe(interruptSpaceSession, ['input', 'caller', 'deps'], 'outcome')
  );

  return [
    defineOperation({
      name: 'session.list',
      policy: READ_POLICY,
      description: `List the ad-hoc and worker sessions in a Space with their derived status, type, workspace, and git branch. ${SCOPE_NOTE} Workflow workers may read sessions. Returns the summaries, newest activity first.`,
      inputSchema: ListSessionsInputSchema,
      resultSchema: SessionListResultSchema,
      execute: (input, caller) => list(input, caller),
    }),
    defineOperation({
      name: 'session.get',
      policy: READ_POLICY,
      description: `Inspect one session in a Space including its parsed processing_state and its last few messages. ${SCOPE_NOTE} Workflow workers may read sessions. Returns the full summary, or session_not_found when the session is absent or owned by another Space.`,
      inputSchema: SessionRefInputSchema,
      resultSchema: SessionDetailResultSchema,
      execute: (input, caller) => detail(input, caller),
    }),
    defineOperation({
      name: 'session.messages.list',
      policy: READ_POLICY,
      description: `Read one Space session conversation newest-first, with a per-message summary and a pagination cursor to pass back as "before". ${SCOPE_NOTE} Workflow workers may read sessions. Returns the messages, or session_not_found.`,
      inputSchema: SessionMessagesInputSchema,
      resultSchema: SessionMessagesResultSchema,
      execute: (input, caller) => messages(input, caller),
    }),
    defineOperation({
      name: 'session.state.update',
      policy: MUTATE_POLICY,
      description: `Force a stuck Space session processing_state to idle, running, or waiting_for_input, for cold-session recovery only. ${SCOPE_NOTE} Documented autonomy requirement: level 4; autonomy enforcement is a later subsystem and is not applied here. Returns the previous and new state, or live_session_present when the session is live (interrupt or message it instead), session_archived, session_not_found, or invalid_state when waiting_for_input is requested without an existing pending question.`,
      inputSchema: UpdateSessionStateInputSchema,
      resultSchema: SessionStateResultSchema,
      execute: (input, caller) => updateState(input, caller),
    }),
    defineOperation({
      name: 'session.interrupt',
      policy: DESTRUCTIVE_POLICY,
      description: `Force-interrupt a running or stuck Space session and reset it to idle. ${SCOPE_NOTE} Documented autonomy requirement: level 4 (destructive); autonomy enforcement is a later subsystem and is not applied here. Returns interrupted, or live_session_required when no live session is cached — use session.state.update for cold session recovery — plus session_archived and session_not_found.`,
      inputSchema: InterruptSessionInputSchema,
      resultSchema: SessionInterruptResultSchema,
      execute: (input, caller) => interrupt(input, caller),
    }),
  ];
}
