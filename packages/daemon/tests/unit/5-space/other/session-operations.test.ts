import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  createSessionOperations,
  type SessionAuditEntry,
} from '../../../../src/lib/session/operations';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

const SPACE_ID = 'space-1';
const READ_ROLES = ['ad_hoc_member', 'long_term_agent', 'workflow_worker'];
const WRITE_ROLES = ['ad_hoc_member', 'long_term_agent'];
const OTHER_SPACE_ID = 'space-2';
const TARGET = 'target-1';

function createSchema(db: BunDatabase): void {
  db.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT, workspace_path TEXT, created_at TEXT, last_active_at TEXT,
    status TEXT, metadata TEXT, is_worktree INTEGER, git_branch TEXT, processing_state TEXT,
    type TEXT, session_context TEXT, space_id TEXT, task_id TEXT
  )`);
  db.run(`CREATE TABLE sdk_messages (
    id TEXT PRIMARY KEY, session_id TEXT, message_type TEXT, message_subtype TEXT,
    is_terminal INTEGER, timestamp TEXT, sdk_message TEXT, sdk_uuid TEXT
  )`);
  db.run(`CREATE TABLE sdk_message_replacements (
    session_id TEXT, target_uuid TEXT
  )`);
}

function insertSession(
  db: BunDatabase,
  overrides: Partial<Record<string, string | number | null>> = {}
): void {
  const row = {
    id: TARGET,
    title: 'Worker session',
    workspace_path: '/repo',
    created_at: '2026-01-01T00:00:00.000Z',
    last_active_at: '2026-01-02T00:00:00.000Z',
    status: 'active',
    metadata: '{"origin":"test"}',
    is_worktree: 1,
    git_branch: 'feature',
    processing_state: '{"status":"idle"}',
    type: 'space_chat',
    session_context: '{"spaceId":"space-1"}',
    space_id: SPACE_ID,
    task_id: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, metadata,
      is_worktree, git_branch, processing_state, type, session_context, space_id, task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.title,
    row.workspace_path,
    row.created_at,
    row.last_active_at,
    row.status,
    row.metadata,
    row.is_worktree,
    row.git_branch,
    row.processing_state,
    row.type,
    row.session_context,
    row.space_id,
    row.task_id
  );
}

function insertMessage(db: BunDatabase, id: string, timestamp: string, text: string): void {
  db.prepare(
    `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, is_terminal, timestamp, sdk_message, sdk_uuid)
     VALUES (?, ?, 'assistant', NULL, 0, ?, ?, ?)`
  ).run(id, TARGET, timestamp, JSON.stringify({ message: { content: text } }), id);
}

function callerSession(status: string, spaceId: string): Session {
  return {
    id: 'member-1',
    type: 'space_chat',
    status,
    context: { spaceId },
    metadata: {},
  } as unknown as Session;
}

interface Harness {
  db: BunDatabase;
  operations: Map<string, OperationDefinition>;
  audits: SessionAuditEntry[];
  sessions: Map<string, Session>;
  live: Map<string, AgentSession>;
  interrupts: string[];
  auditThrows: boolean;
}

function fakeLiveSession(state: Harness, sessionId: string): AgentSession {
  return {
    handleInterrupt: async () => {
      state.interrupts.push(sessionId);
    },
  } as unknown as AgentSession;
}

function harness(): Harness {
  const db = new BunDatabase(':memory:');
  createSchema(db);
  insertSession(db);
  const state: Harness = {
    db,
    operations: new Map(),
    audits: [],
    sessions: new Map([['member-1', callerSession('active', SPACE_ID)]]),
    live: new Map(),
    interrupts: [],
    auditThrows: false,
  };
  const operations = createSessionOperations({
    getDatabase: () => db,
    getLiveSession: (sessionId) => state.live.get(sessionId) ?? null,
    getSession: (sessionId) => state.sessions.get(sessionId) ?? null,
    sessionSpaceId: (session) =>
      (session.context as { spaceId?: string } | undefined)?.spaceId ?? undefined,
    audit: (entry) => {
      if (state.auditThrows) throw new Error('audit down');
      state.audits.push(entry);
    },
  });
  for (const operation of operations) state.operations.set(operation.name, operation);
  return state;
}

function mcpCaller(role: OperationCallerRole, overrides: Partial<OperationCaller> = {}) {
  return {
    source: 'mcp',
    sessionId: 'member-1',
    spaceId: SPACE_ID,
    role,
    agentName: 'planner',
    ...overrides,
  } satisfies OperationCaller;
}

const RPC_CALLER: OperationCaller = { source: 'rpc' };

let h: Harness;

beforeEach(() => {
  h = harness();
});

function run(name: string, input: unknown, caller: OperationCaller) {
  const operation = h.operations.get(name);
  if (!operation) throw new Error(`missing operation: ${name}`);
  return operation.execute(input, caller);
}

function storedProcessingState(sessionId = TARGET): string {
  const row = h.db.prepare('SELECT processing_state FROM sessions WHERE id = ?').get(sessionId) as {
    processing_state: string;
  };
  return row.processing_state;
}

describe('session operation catalog', () => {
  test('registers the five session operations', () => {
    expect([...h.operations.keys()].sort()).toEqual([
      'session.get',
      'session.interrupt',
      'session.list',
      'session.message.list',
      'session.state.update',
    ]);
  });

  test('every session operation declares a policy for the door', () => {
    const policies = [...h.operations.values()].map((operation) => [
      operation.name,
      operation.policy?.safetyClass,
      operation.policy?.roles,
    ]);
    expect(policies).toEqual([
      ['session.list', 'read', READ_ROLES],
      ['session.get', 'read', READ_ROLES],
      ['session.message.list', 'read', READ_ROLES],
      ['session.state.update', 'mutate', WRITE_ROLES],
      ['session.interrupt', 'destructive', WRITE_ROLES],
    ]);
  });

  test('the family scope gate admits a workflow worker inside a session mutation', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'session.state.update',
      { sessionId: TARGET, processingState: 'running' },
      mcpCaller('workflow_worker')
    );
    expect(outcome).toEqual({
      kind: 'completed',
      value: {
        ok: true,
        previous_state: { status: 'idle' },
        new_state: { status: 'processing' },
      },
    });
    expect(JSON.parse(storedProcessingState())).toEqual({ status: 'processing' });
  });

  test('the family scope gate still refuses a caller that carries no Space', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'session.state.update',
      { sessionId: TARGET, processingState: 'running' },
      mcpCaller('ad_hoc_member', { spaceId: undefined })
    );
    expect(outcome).toEqual({
      kind: 'completed',
      value: {
        ok: false,
        reason: 'space_scope_required',
        message: 'A Space is required: pass spaceId, or call from a session inside a Space.',
      },
    });
    expect(JSON.parse(storedProcessingState())).toEqual({ status: 'idle' });
  });

  test('an RPC caller must name the space it is acting in', async () => {
    expect(await run('session.list', {}, RPC_CALLER)).toEqual({
      ok: false,
      reason: 'space_scope_required',
      message: 'A Space is required: pass spaceId, or call from a session inside a Space.',
    });
  });

  test('listing returns derived status, type, and worktree fields', async () => {
    expect(await run('session.list', { spaceId: SPACE_ID }, RPC_CALLER)).toEqual({
      ok: true,
      sessions: [
        {
          id: TARGET,
          title: 'Worker session',
          status: 'idle',
          type: 'ad-hoc',
          processing_state: { status: 'idle' },
          created_at: '2026-01-01T00:00:00.000Z',
          last_active_at: '2026-01-02T00:00:00.000Z',
          is_worktree: true,
          git_branch: 'feature',
          workspace_path: '/repo',
        },
      ],
    });
  });

  test('listing filters by status and type', async () => {
    insertSession(h.db, {
      id: 'worker-9',
      type: 'space_task_agent',
      processing_state: '{"status":"waiting_for_input"}',
    });
    const byType = await run('session.list', { type: 'worker' }, mcpCaller('ad_hoc_member'));
    expect(byType).toMatchObject({ ok: true });
    expect((byType as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual([
      'worker-9',
    ]);
    const byStatus = await run(
      'session.list',
      { status: 'waiting_for_input' },
      mcpCaller('ad_hoc_member')
    );
    expect((byStatus as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)).toEqual([
      'worker-9',
    ]);
  });

  test('a session in another space is not found', async () => {
    insertSession(h.db, { id: 'foreign-1', space_id: OTHER_SPACE_ID });
    expect(
      await run('session.get', { sessionId: 'foreign-1' }, mcpCaller('ad_hoc_member'))
    ).toEqual({
      ok: false,
      reason: 'session_not_found',
      message: 'Session not found in this space: foreign-1',
    });
  });

  test('detail carries raw status, parsed metadata, and the last messages', async () => {
    insertMessage(h.db, 'm1', '2026-01-03T00:00:00.000Z', 'hello   world');
    const result = await run('session.get', { sessionId: TARGET }, mcpCaller('ad_hoc_member'));
    expect(result).toMatchObject({
      ok: true,
      session: {
        raw_status: 'active',
        metadata: { origin: 'test' },
        session_context: { spaceId: SPACE_ID },
      },
    });
    expect(
      (result as { session: { last_messages: Array<{ content_summary: string; cursor: string }> } })
        .session.last_messages
    ).toEqual([
      {
        id: 'm1',
        message_type: 'assistant',
        message_subtype: null,
        is_terminal: false,
        timestamp: '2026-01-03T00:00:00.000Z',
        cursor: '2026-01-03T00:00:00.000Z|m1',
        content_summary: 'hello world',
      },
    ]);
  });

  test('messages page newest-first and honour the before cursor', async () => {
    insertMessage(h.db, 'm1', '2026-01-03T00:00:00.000Z', 'first');
    insertMessage(h.db, 'm2', '2026-01-04T00:00:00.000Z', 'second');
    const all = await run(
      'session.message.list',
      { sessionId: TARGET },
      mcpCaller('ad_hoc_member')
    );
    expect((all as { messages: Array<{ id: string }> }).messages.map((m) => m.id)).toEqual([
      'm2',
      'm1',
    ]);
    const paged = await run(
      'session.message.list',
      { sessionId: TARGET, before: '2026-01-04T00:00:00.000Z|m2' },
      mcpCaller('ad_hoc_member')
    );
    expect((paged as { messages: Array<{ id: string }> }).messages.map((m) => m.id)).toEqual([
      'm1',
    ]);
  });
});

describe('session state mutations', () => {
  test('state update writes the new processing state and audits it', async () => {
    const result = await run(
      'session.state.update',
      { sessionId: TARGET, processingState: 'running' },
      mcpCaller('ad_hoc_member')
    );
    expect(result).toEqual({
      ok: true,
      previous_state: { status: 'idle' },
      new_state: { status: 'processing' },
    });
    expect(JSON.parse(storedProcessingState())).toEqual({ status: 'processing' });
    expect(h.audits.map((entry) => entry.toolName)).toEqual(['session.state.update']);
  });

  test('state update refuses live sessions and leaves the row untouched', async () => {
    h.live.set(TARGET, fakeLiveSession(h, TARGET));
    expect(
      await run(
        'session.state.update',
        { sessionId: TARGET, processingState: 'idle' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({
      ok: false,
      reason: 'live_session_present',
      message:
        'session.state.update cannot mutate live sessions. Interrupt or message the live session instead.',
    });
    expect(JSON.parse(storedProcessingState())).toEqual({ status: 'idle' });
  });

  test('waiting_for_input without a pending question is rejected', async () => {
    expect(
      await run(
        'session.state.update',
        { sessionId: TARGET, processingState: 'waiting_for_input' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({
      ok: false,
      reason: 'invalid_state',
      message: 'Cannot set waiting_for_input without an existing pending question',
    });
  });

  test('an archived target session cannot be mutated', async () => {
    insertSession(h.db, { id: 'archived-1', status: 'archived' });
    expect(
      await run(
        'session.state.update',
        { sessionId: 'archived-1', processingState: 'idle' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({
      ok: false,
      reason: 'session_archived',
      message: 'Session is archived: archived-1',
    });
  });

  test('interrupt delivers to a live session and audits it', async () => {
    h.live.set(TARGET, fakeLiveSession(h, TARGET));
    expect(
      await run('session.interrupt', { sessionId: TARGET }, mcpCaller('long_term_agent'))
    ).toEqual({ ok: true, interrupted: true });
    expect(h.interrupts).toEqual([TARGET]);
    expect(h.audits.map((entry) => entry.toolName)).toEqual(['session.interrupt']);
  });

  test('a failing audit write does not fail a committed mutation', async () => {
    h.auditThrows = true;
    expect(
      await run(
        'session.state.update',
        { sessionId: TARGET, processingState: 'running' },
        mcpCaller('ad_hoc_member')
      )
    ).toMatchObject({ ok: true });
    expect(JSON.parse(storedProcessingState())).toEqual({ status: 'processing' });
    h.live.set(TARGET, fakeLiveSession(h, TARGET));
    expect(
      await run('session.interrupt', { sessionId: TARGET }, mcpCaller('ad_hoc_member'))
    ).toEqual({ ok: true, interrupted: true });
    expect(h.interrupts).toEqual([TARGET]);
  });

  test('interrupt without a live session points at the cold-recovery path', async () => {
    expect(
      await run('session.interrupt', { sessionId: TARGET }, mcpCaller('ad_hoc_member'))
    ).toEqual({
      ok: false,
      reason: 'live_session_required',
      message:
        'session.interrupt requires a live cached session. Use session.state.update for cold session recovery.',
    });
    expect(h.interrupts).toEqual([]);
  });
});

describe('session operation role admission', () => {
  test('workflow workers may read sessions', async () => {
    expect(await run('session.list', {}, mcpCaller('workflow_worker'))).toMatchObject({ ok: true });
    expect(
      await run('session.get', { sessionId: TARGET }, mcpCaller('workflow_worker'))
    ).toMatchObject({ ok: true });
    expect(
      await run('session.message.list', { sessionId: TARGET }, mcpCaller('workflow_worker'))
    ).toMatchObject({ ok: true });
  });

  test('workflow workers may change session state', async () => {
    expect(
      await run(
        'session.state.update',
        { sessionId: TARGET, processingState: 'running' },
        mcpCaller('workflow_worker')
      )
    ).toMatchObject({ ok: true, new_state: { status: 'processing' } });
    expect(JSON.parse(storedProcessingState())).toEqual({ status: 'processing' });
    h.live.set(TARGET, fakeLiveSession(h, TARGET));
    expect(
      await run('session.interrupt', { sessionId: TARGET }, mcpCaller('workflow_worker'))
    ).toEqual({ ok: true, interrupted: true });
    expect(h.interrupts).toEqual([TARGET]);
  });

  test('roles outside the space family may read as well', async () => {
    for (const role of ['outside_space', 'legacy_task_agent', 'direct_task_worker'] as const) {
      expect(await run('session.list', {}, mcpCaller(role))).toMatchObject({ ok: true });
    }
  });

  test('an archived caller session may not mutate, and nothing changes', async () => {
    h.sessions.set('member-1', callerSession('archived', SPACE_ID));
    expect(
      await run(
        'session.state.update',
        { sessionId: TARGET, processingState: 'running' },
        mcpCaller('ad_hoc_member')
      )
    ).toEqual({
      ok: false,
      reason: 'denied',
      message: 'This caller may not use Space sessions.',
    });
    expect(JSON.parse(storedProcessingState())).toEqual({ status: 'idle' });
    expect(h.audits).toEqual([]);
  });

  test('a caller session that left the owning space may not mutate', async () => {
    h.sessions.set('member-1', callerSession('active', OTHER_SPACE_ID));
    expect(
      await run(
        'session.state.update',
        { sessionId: TARGET, processingState: 'running' },
        mcpCaller('ad_hoc_member')
      )
    ).toMatchObject({ ok: false, reason: 'denied' });
    expect(JSON.parse(storedProcessingState())).toEqual({ status: 'idle' });
  });

  test('an MCP caller may not override its own space', async () => {
    expect(
      await run('session.list', { spaceId: OTHER_SPACE_ID }, mcpCaller('ad_hoc_member'))
    ).toEqual({
      ok: false,
      reason: 'space_mismatch',
      message: 'The requested spaceId does not match the calling session Space.',
    });
  });
});

describe('invokeOperation', () => {
  test('session results satisfy their declared result schemas', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    expect(
      await invokeOperation(
        registry,
        'session.get',
        { sessionId: TARGET },
        mcpCaller('ad_hoc_member')
      )
    ).toMatchObject({ kind: 'completed' });
    expect(
      await invokeOperation(
        registry,
        'session.state.update',
        { sessionId: TARGET, processingState: 'idle' },
        mcpCaller('ad_hoc_member')
      )
    ).toMatchObject({ kind: 'completed' });
  });

  test('caller identity fields are rejected as unknown input', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'session.list',
      { spaceId: SPACE_ID, role: 'long_term_agent', agentId: 'someone-else' },
      RPC_CALLER
    );
    expect(outcome.kind).toBe('failed');
  });
});
