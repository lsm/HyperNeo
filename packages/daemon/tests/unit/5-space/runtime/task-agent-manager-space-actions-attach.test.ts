import { describe, test, expect, spyOn } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { z } from 'zod';
import { createAuditOperations } from '../../../../src/lib/audit/operations.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
  type OperationDefinition,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import { createDiscoveryOperations } from '../../../../src/lib/operations/discovery.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { HookEngine } from '../../../../src/lib/hooks/hook-engine.ts';
import { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { hasRuntimeWorkerOperations } from '../../../../src/lib/session/sub-session-identity.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { MessageHub, type McpServerConfig, type SpaceWorkflow } from '@hyperneo/shared';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';
import { createSpaceTables } from '../../helpers/space-test-db';

const SPACE_ID = 'space-actions-attach';
const RUN_ID = 'run-actions-attach';
const TASK_ID = 'task-actions-attach';
const EXEC_ID = 'exec-actions-attach';
const SUB_SESSION_ID = `space:${SPACE_ID}:task:${TASK_ID}:exec:${EXEC_ID}`;

function catalogRegistry(operations: OperationDefinition[]): OperationRegistry {
  const registry = createOperationRegistry([
    ...operations,
    ...createDiscoveryOperations(() => registry),
  ]);
  return registry;
}

function makeManager(
  operations: OperationDefinition[] = [],
  workflow: SpaceWorkflow | null = null
): TaskAgentManager {
  const execution = {
    id: EXEC_ID,
    workflowRunId: RUN_ID,
    workflowNodeId: 'node-coder',
    agentName: 'coder',
    agentId: 'agent-coder',
    agentSessionId: SUB_SESSION_ID,
    status: 'in_progress',
  };
  const task = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, taskNumber: 7 };
  return new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:') },
    internalEventBus: { subscribe: () => () => {} },
    sessionManager: { getOperationRegistry: () => catalogRegistry(operations) },
    taskRepo: {
      getTask: () => task,
      getTaskByNumber: () => task,
      listByWorkflowRun: () => [task],
    },
    nodeExecutionRepo: { listByWorkflowRun: () => [execution] },
    workflowRunRepo: {
      getRun: () =>
        workflow ? { id: RUN_ID, workflowId: workflow.id, createdAt: Date.now() } : null,
    },
    spaceWorkflowManager: { getWorkflowForRun: () => workflow },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, autonomyLevel: 3 }) },
    spaceRuntimeService: {
      getSpaceRuntime: () =>
        ({}) as unknown as import('../../../../src/lib/space/runtime/space-runtime.ts').SpaceRuntime,
      isWorkflowRunActive: () => true,
      activateWorkflowNode: async () => [],
      ensureToolTargetSession: async () =>
        ({
          kind: 'unresolved',
          reason: 'test',
        }) as import('../../../../src/lib/session-resolution/target.ts').EnsureSessionOutcome,
    },
  } as unknown as TaskAgentManagerConfig);
}

function catalogNames(operations: OperationDefinition[]): ReadonlySet<string> {
  return new Set(catalogRegistry(operations).entries.map((operation) => operation.name));
}

function sessionGetOperation(): OperationDefinition {
  return defineOperation({
    name: 'session.get',
    description: 'session.get',
    inputSchema: z.unknown(),
    resultSchema: z.unknown(),
    execute: async () => 'read',
  }) as OperationDefinition;
}

function sendMessageOperation(): OperationDefinition {
  return defineOperation({
    name: 'send_message',
    description: 'send_message',
    inputSchema: z.unknown(),
    resultSchema: z.unknown(),
    execute: async () => 'sent',
  }) as OperationDefinition;
}

function artifactSaveOperation(): OperationDefinition {
  return defineOperation({
    name: 'workflow.run.artifact.save',
    description: 'workflow.run.artifact.save',
    inputSchema: z.unknown(),
    resultSchema: z.unknown(),
    execute: async () => 'saved',
  }) as OperationDefinition;
}

function artifactListOperation(): OperationDefinition {
  return defineOperation({
    name: 'workflow.run.artifact.list',
    description: 'workflow.run.artifact.list',
    inputSchema: z.unknown(),
    resultSchema: z.unknown(),
    execute: async () => [],
  }) as OperationDefinition;
}

function buildServers(tam: TaskAgentManager, agentName = 'coder'): Record<string, McpServerConfig> {
  return tam.buildNodeAgentMcpServersForSession(
    TASK_ID,
    SUB_SESSION_ID,
    agentName,
    SPACE_ID,
    RUN_ID,
    '/tmp/ws',
    'node-coder'
  );
}

function makeFakeSession() {
  const state = {
    merged: [] as Array<Record<string, McpServerConfig>>,
    restarted: 0,
    calls: [] as string[],
    providers: [] as Array<() => OperationRegistry>,
    session: {
      id: SUB_SESSION_ID,
      config: { mcpServers: {} as Record<string, McpServerConfig> | undefined } as Record<
        string,
        unknown
      >,
    },
  };
  const agentSession = {
    get session() {
      return state.session;
    },
    setOperationRegistryProvider: (provider: () => OperationRegistry) => {
      state.providers.push(provider);
    },
    handleInterrupt: async () => {
      state.calls.push('handleInterrupt');
    },
    cleanup: async () => {
      state.calls.push('cleanup');
    },
    mergeRuntimeMcpServers: (additional: Record<string, McpServerConfig>) => {
      state.merged.push(additional);
      state.session.config = {
        ...state.session.config,
        mcpServers: { ...(state.session.config.mcpServers ?? {}), ...additional },
      };
    },
    detachRuntimeMcpServer: (name: string) => {
      state.calls.push(`detachRuntimeMcpServer:${name}`);
      const servers = state.session.config.mcpServers;
      if (servers && name in servers) {
        const next = { ...servers };
        delete next[name];
        state.session.config = { ...state.session.config, mcpServers: next };
      }
    },
    restartQuery: async () => {
      state.restarted += 1;
    },
    getSessionData: () => state.session,
  };
  return { agentSession: agentSession as unknown as AgentSession, state };
}

function contractOf(
  tam: TaskAgentManager,
  agentName = 'coder',
  dispatcherActionNames?: ReadonlySet<string>
): string {
  return (
    tam as unknown as {
      buildNodeExecutionRuntimeContract: (
        w: null,
        e: { agentName: string; workflowNodeId: string },
        s: { autonomyLevel: number } | null,
        names?: ReadonlySet<string>
      ) => string;
    }
  ).buildNodeExecutionRuntimeContract(
    null,
    { agentName, workflowNodeId: 'node-1' },
    { autonomyLevel: 1 },
    dispatcherActionNames
  );
}

describe('TaskAgentManager — space-actions dispatcher attach', () => {
  test('worker sessions attach no MCP servers of their own', () => {
    const tam = makeManager();
    const servers = buildServers(tam);
    expect(Object.keys(servers)).toEqual([]);
  });

  test('building a hook-enabled worker runtime rehydrates queued actions from operations', () => {
    const workflow: SpaceWorkflow = {
      id: 'workflow-actions-attach',
      spaceId: SPACE_ID,
      name: 'Hooked workflow',
      startNodeId: 'node-coder',
      endNodeId: 'node-review',
      nodes: [
        { id: 'node-coder', name: 'Coding', agents: [{ name: 'coder', agentId: 'agent-coder' }] },
        {
          id: 'node-review',
          name: 'Review',
          agents: [{ name: 'reviewer', agentId: 'agent-reviewer' }],
        },
      ],
      channels: [{ id: 'coding-review', from: 'Coding', to: 'Review' }],
      hooks: [
        {
          id: 'review-ready',
          enabled: true,
          sourceNode: 'Coding',
          method: 'send_message',
          classification: 'validation',
          order: 0,
          validator: { kind: 'built_in', id: 'pr_ready' },
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    };
    const operation = sendMessageOperation();
    const registry = catalogRegistry([operation]);
    const schedule = spyOn(
      HookEngine.prototype,
      'scheduleQueuedRetryableOperations'
    ).mockImplementation(() => {});
    const tam = makeManager([operation], workflow);

    buildServers(tam);

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[0].get('send_message')).toBeDefined();
    expect(schedule.mock.calls[0]?.[1]).toEqual({
      source: 'internal',
      sessionId: SUB_SESSION_ID,
      spaceId: SPACE_ID,
      role: 'workflow_worker',
      agentName: 'coder',
    });
    expect(schedule.mock.calls[0]?.[2]).toEqual({
      sessionId: SUB_SESSION_ID,
      agentName: 'coder',
      nodeId: 'node-coder',
      taskId: TASK_ID,
    });
    expect(registry.get('send_message')).toBeDefined();
    schedule.mockRestore();
  });

  test('queued hook restore falls back to the execution node when the identity has no node', () => {
    const workflow: SpaceWorkflow = {
      id: 'workflow-actions-attach',
      spaceId: SPACE_ID,
      name: 'Hooked workflow',
      startNodeId: 'node-coder',
      endNodeId: 'node-review',
      nodes: [
        { id: 'node-coder', name: 'Coding', agents: [{ name: 'coder', agentId: 'agent-coder' }] },
        {
          id: 'node-review',
          name: 'Review',
          agents: [{ name: 'reviewer', agentId: 'agent-reviewer' }],
        },
      ],
      channels: [{ id: 'coding-review', from: 'Coding', to: 'Review' }],
      hooks: [
        {
          id: 'review-ready',
          enabled: true,
          sourceNode: 'Coding',
          method: 'send_message',
          classification: 'validation',
          order: 0,
          validator: { kind: 'built_in', id: 'pr_ready' },
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    };
    const operation = sendMessageOperation();
    const schedule = spyOn(
      HookEngine.prototype,
      'scheduleQueuedRetryableOperations'
    ).mockImplementation(() => {});
    const tam = makeManager([operation], workflow);

    tam.buildNodeAgentMcpServersForSession(
      TASK_ID,
      SUB_SESSION_ID,
      'coder',
      SPACE_ID,
      RUN_ID,
      '/tmp/ws',
      ''
    );

    expect(schedule.mock.calls[0]?.[2]?.nodeId).toBe('node-coder');
    schedule.mockRestore();
  });

  test('reinject (self-heal rebuild path) restarts the query and keeps the session marked', async () => {
    const tam = makeManager();
    const fake = makeFakeSession();
    await tam.reinjectNodeAgentMcpServer(fake.agentSession, {
      taskId: TASK_ID,
      subSessionId: SUB_SESSION_ID,
      agentName: 'coder',
      spaceId: SPACE_ID,
      workflowRunId: RUN_ID,
      workspacePath: '/tmp/ws',
      workflowNodeId: 'node-coder',
    });
    const merged = fake.state.merged.at(-1) ?? {};
    expect(Object.keys(merged)).toEqual([]);
    expect(fake.state.restarted).toBe(1);
    expect(hasRuntimeWorkerOperations(fake.state.session.config)).toBe(true);
  });

  test('reinject replaces a pre-existing space-actions server entry', async () => {
    const tam = makeManager();
    const ctx = {
      taskId: TASK_ID,
      subSessionId: SUB_SESSION_ID,
      agentName: 'coder',
      spaceId: SPACE_ID,
      workflowRunId: RUN_ID,
      workspacePath: '/tmp/ws',
      workflowNodeId: 'node-coder',
    };

    const userProvided = makeFakeSession();
    userProvided.agentSession.mergeRuntimeMcpServers({
      'space-actions': { __userProvided: true } as unknown as McpServerConfig,
    });
    await tam.reinjectNodeAgentMcpServer(userProvided.agentSession, ctx);
    const merged = userProvided.state.merged.at(-1)!;
    expect(Object.keys(merged)).toEqual([]);
    expect(userProvided.state.restarted).toBe(1);
  });

  test('contract renders dispatcher guidance with registry-filtered availability', () => {
    const tam = makeManager();
    const contract = contractOf(tam, 'coder', catalogNames([artifactSaveOperation()]));
    expect(contract).toContain('Tools available:');
    expect(contract).toContain(
      'invoke({ name, input? }) on the operations server — one door for every operation available to the Coder role'
    );
    expect(contract).toContain('invoke(name="operations.list")');
    expect(contract).toContain('invoke(name="workflow.run.artifact.save"');
    expect(contract).not.toContain('invoke(name="update_task")');
    expect(contract).not.toContain('invoke(name="create_standalone_task")');
    expect(contract).not.toContain('send_message({ target, message, data? })');
    expect(contract).not.toContain('Escalation: send_message');
  });

  test('every suggested contract action resolves through the operation catalog', () => {
    for (const agentName of ['coder', 'reviewer']) {
      const operations = [artifactSaveOperation(), artifactListOperation()];
      const tam = makeManager(operations);
      const names = catalogNames(operations);
      const contract = contractOf(tam, agentName, names);
      const suggested = [...contract.matchAll(/invoke\(name="([a-z_.]+)"/g)].map(
        (match) => match[1]
      );
      expect(suggested).toContain('workflow.run.artifact.save');
      expect(suggested).toContain('operations.list');
      for (const name of suggested) {
        expect(names.has(name)).toBe(true);
      }
    }
    const reviewerContract = contractOf(
      makeManager(),
      'reviewer',
      catalogNames([artifactSaveOperation()])
    );
    expect(reviewerContract).toContain('invoke(name="workflow.run.artifact.save"');
  });

  test('worker contract suggestions carry operations the action registry no longer defines', () => {
    const operations = [sendMessageOperation(), artifactSaveOperation()];
    const names = catalogNames(operations);
    expect(names.has('send_message')).toBe(true);
    expect(names.has('workflow.run.artifact.save')).toBe(true);
  });

  test('the contract still suggests send_message once it is only an operation', () => {
    const tam = makeManager([sendMessageOperation()]);
    const contract = contractOf(tam, 'coder', catalogNames([sendMessageOperation()]));
    expect(contract).toContain('invoke(name="send_message")');
  });

  test('the QA contract suggests session.get now that the seed is an operation', () => {
    const tam = makeManager([sessionGetOperation()]);
    const contract = contractOf(tam, 'qa', catalogNames([sessionGetOperation()]));
    expect(contract).toContain('invoke(name="session.get")');
  });

  test('without registry names the contract omits suggestions instead of guessing', () => {
    const contract = contractOf(makeManager(), 'coder', undefined);
    expect(contract).toContain(
      'invoke({ name, input? }) on the operations server — one door for every operation available to the Coder role'
    );
    expect(contract).toContain('invoke(name="operations.list")');
    expect(contract).not.toContain('Suggested:');
  });
});

describe('TaskAgentManager — worker operations attach (#4600)', () => {
  test('attachWorkerOperations marks the session as carrying runtime worker operations', () => {
    const tam = makeManager();
    buildServers(tam);
    const fake = makeFakeSession();
    expect(hasRuntimeWorkerOperations(fake.state.session.config)).toBe(false);

    tam.attachWorkerOperations(fake.agentSession);

    expect(hasRuntimeWorkerOperations(fake.state.session.config)).toBe(true);
    expect(fake.state.providers).toEqual([]);
    expect(fake.state.session.config.mcpServers).toEqual({});
  });

  test('a worker session reaches space.audit.list through the operations door', async () => {
    const auditDb = new Database(':memory:');
    createSpaceTables(auditDb);
    const auditOperations = createAuditOperations({
      auditLogRepo: new McpAuditLogRepository(auditDb),
    });
    const registry = catalogRegistry(auditOperations);
    expect(registry.entries.some((operation) => operation.name === 'space.audit.list')).toBe(true);
    const outcome = await invokeOperation(
      registry,
      'space.audit.list',
      { spaceId: SPACE_ID },
      {
        source: 'mcp',
        sessionId: SUB_SESSION_ID,
        spaceId: SPACE_ID,
        role: 'workflow_worker',
      }
    );
    expect(outcome).toEqual({
      kind: 'completed',
      value: { ok: true, entries: [], total: 0, hasMore: false },
    });
    auditDb.close();
  });

  test('stopping a sub-session interrupts and cleans it up', async () => {
    const tam = makeManager();
    buildServers(tam);
    const fake = makeFakeSession();

    await (
      tam as unknown as {
        stopSessionPreserveDb: (sessionId: string, session: AgentSession) => Promise<void>;
      }
    ).stopSessionPreserveDb(SUB_SESSION_ID, fake.agentSession);

    expect(fake.state.calls).toEqual(['handleInterrupt', 'cleanup']);
  });

  test('global template operations reach execution for the worker session now that the generic door is removed', async () => {
    const TEMPLATE_OPS = [
      'agent.template.create',
      'agent.template.update',
      'agent.template.delete',
      'agent.template.list',
      'agent.template.instantiate',
    ];
    const ops = TEMPLATE_OPS.map((name) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.object({}).passthrough(),
        resultSchema: z.unknown(),
        policy: { safetyClass: 'mutate', roles: ['long_term_agent'] },
        execute: async () => `ran ${name}`,
      })
    );
    const registry = catalogRegistry(ops);
    const workerCaller: OperationCaller = {
      source: 'mcp',
      sessionId: SUB_SESSION_ID,
      spaceId: SPACE_ID,
      role: 'workflow_worker',
    };
    for (const name of TEMPLATE_OPS) {
      expect(registry.get(name)).toBeDefined();
      const outcome = await invokeOperation(registry, name, {}, workerCaller);
      expect(outcome).toEqual({ kind: 'completed', value: `ran ${name}` });
    }
  });

  test('registerSession keeps a session-scoped provider installed ahead of it', async () => {
    const db = await createTestDb();
    const hub = new MessageHub();
    const bus = await createTestInternalEventBus();
    const manager = new SessionManager(
      db,
      hub,
      { getCurrentApiKey: async () => null } as ConstructorParameters<typeof SessionManager>[2],
      {} as ConstructorParameters<typeof SessionManager>[3],
      bus,
      { defaultModel: 'claude-sonnet-4-20250514', disableWorktrees: true },
      db.getJobQueueRepo(),
      {} as ConstructorParameters<typeof SessionManager>[7]
    );
    const restore = (id: string) => {
      db.createSession(createTestSession(id));
      const session = AgentSession.restore(
        id,
        db,
        hub,
        bus,
        async () => null,
        undefined,
        undefined,
        {
          autoReplayPendingMessages: false,
        }
      );
      if (!session) throw new Error(`restore failed for ${id}`);
      return session;
    };
    const scoped = createOperationRegistry([
      defineOperation({
        name: 'worker_probe',
        description: 'worker_probe',
        inputSchema: z.unknown(),
        resultSchema: z.unknown(),
        execute: async () => 'probed',
      }),
    ]);
    const worker = restore('worker-scoped');
    const plain = restore('plain-global');
    try {
      worker.setOperationRegistryProvider(() => scoped);
      manager.registerSession(worker);
      manager.registerSession(plain);
      manager.setOperationRegistryProvider(() => createOperationRegistry([]));

      const probe = async (session: AgentSession) =>
        (await session.getOperationMcpServer().tools[0].handler({ name: 'worker_probe' }, {}))
          .isError;
      expect(await probe(worker)).not.toBe(true);
      expect(await probe(plain)).toBe(true);
    } finally {
      await worker.cleanup();
      await plain.cleanup();
      hub.cleanup();
      db.close();
    }
  });
});
