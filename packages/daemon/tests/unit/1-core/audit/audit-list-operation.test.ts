import { beforeEach, describe, expect, test } from 'bun:test';
import { createAuditOperations, resolveAuditScope } from '../../../../src/lib/audit/operations';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

const SPACE_ID = 'space-1';
const OTHER_SPACE_ID = 'space-2';
const READ_ROLES = ['ad_hoc_member', 'long_term_agent', 'universal_read', 'workflow_worker'];

interface SeededRow {
  id: string;
  timestamp: number;
  agentName: string | null;
  sessionId: string | null;
  toolName: string;
  paramsSummary: string | null;
  spaceId: string;
  taskId: string | null;
  workflowRunId: string | null;
}

const SEEDED: SeededRow[] = [
  {
    id: 'e1',
    timestamp: 400,
    agentName: 'coder',
    sessionId: 's-1',
    toolName: 'send_message',
    paramsSummary: '{"target":"reviewer"}',
    spaceId: SPACE_ID,
    taskId: 'task-1',
    workflowRunId: 'run-1',
  },
  {
    id: 'e2',
    timestamp: 300,
    agentName: 'coder',
    sessionId: 's-1',
    toolName: 'save_artifact',
    paramsSummary: null,
    spaceId: SPACE_ID,
    taskId: 'task-1',
    workflowRunId: 'run-1',
  },
  {
    id: 'e3',
    timestamp: 200,
    agentName: 'planner',
    sessionId: 's-2',
    toolName: 'task.update',
    paramsSummary: '{"status":"blocked"}',
    spaceId: SPACE_ID,
    taskId: 'task-2',
    workflowRunId: 'run-2',
  },
  {
    id: 'x1',
    timestamp: 500,
    agentName: 'stranger',
    sessionId: 's-9',
    toolName: 'send_message',
    paramsSummary: null,
    spaceId: OTHER_SPACE_ID,
    taskId: 'task-1',
    workflowRunId: 'run-9',
  },
];

interface Harness {
  db: Database;
  repo: McpAuditLogRepository;
  operations: Map<string, OperationDefinition>;
  rows: SeededRow[];
}

function insertRow(db: Database, row: SeededRow): void {
  db.prepare(
    `INSERT INTO mcp_audit_log (id, timestamp, agent_name, session_id, tool_name, params_summary, space_id, task_id, workflow_run_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.timestamp,
    row.agentName,
    row.sessionId,
    row.toolName,
    row.paramsSummary,
    row.spaceId,
    row.taskId,
    row.workflowRunId
  );
}

function harness(): Harness {
  const db = new Database(':memory:');
  createSpaceTables(db);
  const state: Harness = {
    db,
    repo: new McpAuditLogRepository(db),
    operations: new Map(),
    rows: SEEDED.map((row) => ({ ...row })),
  };
  for (const row of state.rows) insertRow(db, row);
  for (const operation of createAuditOperations({ auditLogRepo: state.repo })) {
    state.operations.set(operation.name, operation);
  }
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

function run(input: unknown, caller: OperationCaller = RPC_CALLER) {
  const operation = h.operations.get('audit.list');
  if (!operation) throw new Error('missing operation: audit.list');
  return operation.execute(input, caller);
}

describe('audit.list operation', () => {
  test('registers audit.list with a read policy for the door', () => {
    expect([...h.operations.keys()]).toEqual(['audit.list']);
    const policy = h.operations.get('audit.list')?.policy;
    expect(policy?.safetyClass).toBe('read');
    expect(policy?.roles).toEqual(READ_ROLES);
  });

  test('returns the Space audit page newest first with total and hasMore', async () => {
    const result = await run({ spaceId: SPACE_ID });
    expect(result).toEqual({
      ok: true,
      entries: [
        {
          id: 'e1',
          timestamp: 400,
          agentName: 'coder',
          sessionId: 's-1',
          toolName: 'send_message',
          paramsSummary: '{"target":"reviewer"}',
          spaceId: SPACE_ID,
          taskId: 'task-1',
          workflowRunId: 'run-1',
        },
        {
          id: 'e2',
          timestamp: 300,
          agentName: 'coder',
          sessionId: 's-1',
          toolName: 'save_artifact',
          paramsSummary: null,
          spaceId: SPACE_ID,
          taskId: 'task-1',
          workflowRunId: 'run-1',
        },
        {
          id: 'e3',
          timestamp: 200,
          agentName: 'planner',
          sessionId: 's-2',
          toolName: 'task.update',
          paramsSummary: '{"status":"blocked"}',
          spaceId: SPACE_ID,
          taskId: 'task-2',
          workflowRunId: 'run-2',
        },
      ],
      total: 3,
      hasMore: false,
    });
  });

  test('pages with limit and offset', async () => {
    const firstPage = await run({ spaceId: SPACE_ID, limit: 2 });
    expect(firstPage).toMatchObject({
      entries: [h.rows[0], h.rows[1]].map((row) => ({ id: row.id })),
      total: 3,
      hasMore: true,
    });
    const lastPage = await run({ spaceId: SPACE_ID, limit: 2, offset: 2 });
    expect(lastPage).toMatchObject({
      entries: [{ id: 'e3' }],
      total: 3,
      hasMore: false,
    });
    const pastEnd = await run({ spaceId: SPACE_ID, offset: 5 });
    expect(pastEnd).toMatchObject({ entries: [], total: 3, hasMore: false });
  });

  test('defaults to a limit of 20', async () => {
    for (let index = 0; index < 25; index += 1) {
      insertRow(h.db, {
        id: `bulk-${index}`,
        timestamp: 1000 + index,
        agentName: 'bulk',
        sessionId: null,
        toolName: 'invoke',
        paramsSummary: null,
        spaceId: OTHER_SPACE_ID,
        taskId: null,
        workflowRunId: null,
      });
    }
    const result = await run({ spaceId: OTHER_SPACE_ID });
    expect(result).toMatchObject({ total: 26, hasMore: true });
    if (!('entries' in result) || !result.ok) throw new Error('expected a page');
    expect(result.entries).toHaveLength(20);
    expect(result.entries.every((entry) => entry.agentName === 'bulk')).toBe(true);
  });

  test('filters by task within the Space', async () => {
    const result = await run({ spaceId: SPACE_ID, taskId: 'task-1' });
    expect(result).toMatchObject({
      entries: [{ id: 'e1' }, { id: 'e2' }],
      total: 2,
      hasMore: false,
    });
  });

  test('filters by session within the Space', async () => {
    const result = await run({ spaceId: SPACE_ID, sessionId: 's-2' });
    expect(result).toMatchObject({
      entries: [{ id: 'e3' }],
      total: 1,
      hasMore: false,
    });
  });

  test('prefers taskId when both taskId and sessionId are given', async () => {
    const result = await run({ spaceId: SPACE_ID, taskId: 'task-1', sessionId: 's-2' });
    expect(result).toMatchObject({
      entries: [{ id: 'e1' }, { id: 'e2' }],
      total: 2,
    });
  });

  test('an MCP caller inherits the Space of its own session', async () => {
    const result = await run({}, mcpCaller('ad_hoc_member'));
    expect(result).toMatchObject({
      entries: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
      total: 3,
    });
  });

  test('an MCP caller may not list another Space', async () => {
    const result = await run(
      { spaceId: OTHER_SPACE_ID },
      mcpCaller('ad_hoc_member', { spaceId: SPACE_ID })
    );
    expect(result).toEqual({
      ok: false,
      reason: 'space_mismatch',
      message: 'The requested spaceId does not match the calling session Space.',
    });
  });

  test('an MCP caller without a Space is told a scope is required', async () => {
    const result = await run({}, mcpCaller('ad_hoc_member', { spaceId: undefined }));
    expect(result).toEqual({
      ok: false,
      reason: 'space_scope_required',
      message: 'A Space is required: pass spaceId, or call from a session inside a Space.',
    });
  });

  test('rejects an RPC caller that passes no spaceId', async () => {
    const result = await run({});
    expect(result).toEqual({
      ok: false,
      reason: 'space_scope_required',
      message: 'A Space is required: pass spaceId, or call from a session inside a Space.',
    });
  });

  test('reports a failed audit query as rejected', async () => {
    h.db.close();
    const result = await run({ spaceId: SPACE_ID });
    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
  });

  test('validates input and result through the operations door', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    const invalid = await invokeOperation(
      registry,
      'audit.list',
      { spaceId: SPACE_ID, limit: 0 },
      RPC_CALLER
    );
    expect(invalid).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    const completed = await invokeOperation(
      registry,
      'audit.list',
      { spaceId: SPACE_ID, limit: 1 },
      RPC_CALLER
    );
    expect(completed).toEqual({
      kind: 'completed',
      value: {
        ok: true,
        entries: [
          {
            id: 'e1',
            timestamp: 400,
            agentName: 'coder',
            sessionId: 's-1',
            toolName: 'send_message',
            paramsSummary: '{"target":"reviewer"}',
            spaceId: SPACE_ID,
            taskId: 'task-1',
            workflowRunId: 'run-1',
          },
        ],
        total: 3,
        hasMore: true,
      },
    });
  });

  test('the family scope gate refuses a caller role outside the policy', async () => {
    const registry = createOperationRegistry([...h.operations.values()]);
    const outcome = await invokeOperation(
      registry,
      'audit.list',
      { spaceId: SPACE_ID },
      mcpCaller('legacy_task_agent')
    );
    expect(outcome).toEqual({
      kind: 'completed',
      value: {
        ok: false,
        reason: 'denied',
        message: 'This caller may not read the Space audit log.',
      },
    });
  });
});

describe('resolveAuditScope', () => {
  test('maps an unadmitted MCP role to a denied rejection', () => {
    const scope = resolveAuditScope({}, mcpCaller('legacy_task_agent'), {
      readOnly: true,
      workerAllowed: true,
    });
    expect(scope).toEqual({
      reason: {
        ok: false,
        reason: 'denied',
        message: 'This caller may not read the Space audit log.',
      },
    });
  });
});
