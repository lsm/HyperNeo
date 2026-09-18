import { describe, expect, mock, test } from 'bun:test';
import type { CallContext } from '@hyperneo/shared';
import { z } from 'zod';
import {
  createOperationAuditWriter,
  summarizeAuditInput,
  toAuditLogParams,
  type OperationAuditRecord,
} from '../../../../src/lib/operations/audit';
import { invokeOperation, type InvokeDependencies } from '../../../../src/lib/operations/invoke';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
  type OperationPolicy,
} from '../../../../src/lib/operations/registry';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';

const context: CallContext = {
  messageId: 'request-1',
  sessionId: 'global',
  method: 'operation.invoke',
  timestamp: 'now',
};

function fixture(policy?: OperationPolicy) {
  const execute = mock(async (input: { content: string; secret?: string }) => ({
    accepted: input.content,
  }));
  const registry = createOperationRegistry([
    defineOperation({
      name: 'task.act',
      description: 'Act on a task',
      inputSchema: z.object({ content: z.string().min(1), secret: z.string().optional() }),
      resultSchema: z.object({ accepted: z.string() }),
      policy,
      execute,
    }),
  ]);
  const written: OperationAuditRecord[] = [];
  let clock = 1000;
  const dependencies: InvokeDependencies = {
    audit: (record) => {
      written.push(record);
    },
    now: () => (clock += 25),
  };
  return { execute, registry, written, dependencies };
}

const mcpCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'agent-session',
  spaceId: 'space-1',
  role: 'workflow_worker',
  agentId: 'agent-7',
  agentName: 'Scout',
};

describe('auditInvocation through invokeOperation', () => {
  test('records the caller, outcome and duration of a completed invocation', async () => {
    const { registry, written, dependencies } = fixture();
    expect(
      await invokeOperation(registry, 'task.act', { content: 'hello' }, mcpCaller, dependencies)
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      operation: 'task.act',
      caller: mcpCaller,
      outcome: 'completed',
      durationMs: 25,
      inputSummary: JSON.stringify({ content: 'hello' }),
    });
  });

  test.each([
    {
      label: 'unknown_operation',
      name: 'task.missing',
      input: { content: 'hello' },
      policy: undefined,
      code: 'unknown_operation',
      summary: null,
    },
    {
      label: 'invalid_input',
      name: 'task.act',
      input: { content: '' },
      policy: undefined,
      code: 'invalid_input',
      summary: JSON.stringify({ content: '' }),
    },
  ])(
    'records a $label denial with its failure code',
    async ({ name, input, policy, code, summary }) => {
      const { registry, written, dependencies, execute } = fixture(policy);
      expect(await invokeOperation(registry, name, input, mcpCaller, dependencies)).toMatchObject({
        kind: 'failed',
        code,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        operation: name,
        outcome: 'failed',
        failureCode: code,
        inputSummary: summary,
      });
    }
  );

  test('records a failed execution after the operation threw', async () => {
    const { registry, written, dependencies, execute } = fixture();
    execute.mockRejectedValue(new Error('unavailable'));
    expect(
      await invokeOperation(registry, 'task.act', { content: 'hello' }, mcpCaller, dependencies)
    ).toMatchObject({ kind: 'failed', code: 'execution_failed' });
    expect(written[0]).toMatchObject({ outcome: 'failed', failureCode: 'execution_failed' });
  });

  test('applies the declared redaction keys to the summary', async () => {
    const { registry, written, dependencies } = fixture({
      safetyClass: 'mutate',
      audit: { redactKeys: ['secret'] },
    });
    await invokeOperation(
      registry,
      'task.act',
      { content: 'hello', secret: 'hunter2' },
      mcpCaller,
      dependencies
    );
    expect(written[0]?.inputSummary).toBe(
      JSON.stringify({ content: 'hello', secret: '[redacted]' })
    );
  });

  test('a self-audited operation writes no door row on success but still runs', async () => {
    const { registry, written, dependencies, execute } = fixture({
      safetyClass: 'read',
      audit: { selfAudited: true },
    });
    expect(
      await invokeOperation(registry, 'task.act', { content: 'hello' }, mcpCaller, dependencies)
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(0);
  });

  function selfAuditedReturning(value: unknown) {
    const registry = createOperationRegistry([
      defineOperation({
        name: 'task.act',
        description: 'Act on a task',
        inputSchema: z.object({ content: z.string().min(1) }),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'mutate', audit: { selfAudited: true } },
        execute: mock(async () => value),
      }),
    ]);
    const written: OperationAuditRecord[] = [];
    return {
      written,
      invoke: () =>
        invokeOperation(registry, 'task.act', { content: 'hello' }, mcpCaller, {
          audit: (record) => {
            written.push(record);
          },
        }),
    };
  }

  test.each([
    { label: 'accepted:false', value: { accepted: false, reason: 'owner_denied' } },
    { label: 'ok:false', value: { ok: false, reason: 'denied', message: 'no write access' } },
    { label: 'success:false', value: { success: false, error: 'node_caller_denied' } },
    { label: 'rejected:true', value: { rejected: true, reason: 'agent_not_found', message: 'no' } },
  ])(
    'a self-audited operation still writes a door row for a $label rejection',
    async ({ value }) => {
      const { written, invoke } = selfAuditedReturning(value);
      expect((await invoke()).kind).toBe('completed');
      expect(written).toHaveLength(1);
      expect(written[0]?.outcome).toBe('completed');
    }
  );

  test.each([
    { label: 'accepted:true', value: { accepted: true, goal: 'g-1' } },
    { label: 'ok:true', value: { ok: true, schedule: 's-1' } },
    { label: 'success:true', value: { success: true, artifact: 'a-1' } },
    { label: 'a plain payload', value: { agent: 'a-1' } },
  ])('a self-audited operation writes no door row for a $label success', async ({ value }) => {
    const { written, invoke } = selfAuditedReturning(value);
    expect((await invoke()).kind).toBe('completed');
    expect(written).toHaveLength(0);
  });

  test('a self-audited operation still writes a door row when the call is refused', async () => {
    const { registry, written, dependencies, execute } = fixture({
      safetyClass: 'read',
      audit: { selfAudited: true },
    });
    const outcome = await invokeOperation(
      registry,
      'task.act',
      { content: '' },
      mcpCaller,
      dependencies
    );
    expect(outcome.kind).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    expect(written[0]?.outcome).toBe('failed');
    expect(written[0]?.failureCode).toBe('invalid_input');
  });

  test('a throwing audit writer does not change the outcome', async () => {
    const { registry, execute } = fixture();
    const audit = mock(() => {
      throw new Error('audit storage offline');
    });
    expect(
      await invokeOperation(registry, 'task.act', { content: 'hello' }, mcpCaller, { audit })
    ).toEqual({ kind: 'completed', value: { accepted: 'hello' } });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('omitting the dependencies leaves the invocation unchanged', async () => {
    const { registry } = fixture();
    expect(await invokeOperation(registry, 'task.act', { content: 'hello' }, mcpCaller)).toEqual({
      kind: 'completed',
      value: { accepted: 'hello' },
    });
  });
});

describe('createOperationRpcHandler and createOperationMcpHandler audit both doors', () => {
  test('the rpc door audits the invocation it serves', async () => {
    const { registry, written, dependencies } = fixture();
    const handler = createOperationRpcHandler(registry, () => ({}), dependencies);
    expect(await handler({ name: 'task.act', input: { content: 'hello' } }, context)).toEqual({
      accepted: 'hello',
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.caller).toMatchObject({ source: 'rpc' });
  });

  test('the mcp door audits the invocation it serves', async () => {
    const { registry, written, dependencies } = fixture();
    const handler = createOperationMcpHandler(
      registry,
      () => ({ sessionId: 'agent-session', spaceId: 'space-1' }),
      () => dependencies
    );
    await handler({ name: 'task.act', input: { content: 'hello' } });
    expect(written).toHaveLength(1);
    expect(written[0]?.caller).toEqual({
      source: 'mcp',
      sessionId: 'agent-session',
      spaceId: 'space-1',
    });
  });
});

describe('summarizeAuditInput', () => {
  test('returns null for an unresolved operation so unknown input is never recorded', () => {
    expect(summarizeAuditInput(undefined, { secret: 'hunter2' })).toBeNull();
  });

  test('redacts the whole value when the input is not a plain object', () => {
    const operation = defineOperation({
      name: 'task.act',
      description: 'Act',
      inputSchema: z.string(),
      resultSchema: z.string(),
      policy: { safetyClass: 'mutate', audit: { redactKeys: ['secret'] } },
      execute: async (input) => input,
    });
    expect(summarizeAuditInput(operation, 'hunter2')).toBe('[redacted]');
  });
});

describe('createOperationAuditWriter and toAuditLogParams', () => {
  const record: OperationAuditRecord = {
    operation: 'task.act',
    caller: mcpCaller,
    outcome: 'failed',
    failureCode: 'forbidden',
    durationMs: 12,
    inputSummary: '{"content":"hello"}',
  };

  test('maps a record onto the audit log row shape', () => {
    expect(toAuditLogParams(record)).toEqual({
      toolName: 'task.act',
      sessionId: 'agent-session',
      spaceId: 'space-1',
      agentName: 'Scout',
      callerSource: 'mcp',
      callerRole: 'workflow_worker',
      callerAgentId: 'agent-7',
      outcome: 'failed',
      failureCode: 'forbidden',
      durationMs: 12,
      paramsSummary: '{"content":"hello"}',
    });
  });

  test('nulls every caller field an rpc caller does not carry', () => {
    const createEntry = mock(() => ({}));
    createOperationAuditWriter(createEntry)({
      ...record,
      caller: { source: 'rpc' },
      outcome: 'completed',
      failureCode: undefined,
    });
    expect(createEntry).toHaveBeenCalledWith({
      toolName: 'task.act',
      sessionId: null,
      spaceId: null,
      agentName: null,
      callerSource: 'rpc',
      callerRole: null,
      callerAgentId: null,
      outcome: 'completed',
      failureCode: null,
      durationMs: 12,
      paramsSummary: '{"content":"hello"}',
    });
  });
});
