import { describe, test, expect } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { z } from 'zod';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationDefinition,
  type OperationRegistry,
} from '../../../../src/lib/operations/registry.ts';
import { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { hasRuntimeWorkerOperations } from '../../../../src/lib/session/sub-session-identity.ts';
import { MessageHub, type McpServerConfig } from '@hyperneo/shared';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

const SPACE_ID = 'space-actions-attach';
const RUN_ID = 'run-actions-attach';
const TASK_ID = 'task-actions-attach';
const EXEC_ID = 'exec-actions-attach';
const SUB_SESSION_ID = `space:${SPACE_ID}:task:${TASK_ID}:exec:${EXEC_ID}`;

function makeManager(operations: OperationDefinition[] = []): TaskAgentManager {
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
    sessionManager: { getOperationRegistry: () => createOperationRegistry(operations) },
    taskRepo: {
      getTask: () => task,
      getTaskByNumber: () => task,
      listByWorkflowRun: () => [task],
    },
    nodeExecutionRepo: { listByWorkflowRun: () => [execution] },
    workflowRunRepo: { getRun: () => null },
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

function workerActionNames(tam: TaskAgentManager, agentName = 'coder'): ReadonlySet<string> {
  buildServers(tam, agentName);
  return tam.workerActionNamesFor(SUB_SESSION_ID) ?? new Set<string>();
}

describe('TaskAgentManager — space-actions dispatcher attach', () => {
  test('worker sessions attach no MCP servers of their own', () => {
    const tam = makeManager();
    const servers = buildServers(tam);
    expect(Object.keys(servers)).toEqual([]);
    expect(tam.workerActionRegistryFor(SUB_SESSION_ID)?.get('list_actions')).toBeDefined();
    expect(
      tam.workerActionRegistryFor(SUB_SESSION_ID)?.get('approve_pending_completion')
    ).toBeUndefined();
  });

  test('reinject (self-heal rebuild path) reinstalls operations and restarts the query', async () => {
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
    expect(tam.workerActionRegistryFor(SUB_SESSION_ID)).toBeDefined();
    expect(fake.state.restarted).toBe(1);
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
    const contract = contractOf(tam, 'coder', workerActionNames(tam));
    expect(contract).toContain('Tools available:');
    expect(contract).toContain(
      'invoke({ name, input? }) on the operations server — one door for every operation available to the Coder role'
    );
    expect(contract).toContain('invoke(name="operations.list")');
    expect(contract).toContain('invoke(name="save_artifact"');
    expect(contract).not.toContain('invoke(name="update_task")');
    expect(contract).not.toContain('invoke(name="create_standalone_task")');
    expect(contract).not.toContain('send_message({ target, message, data? })');
    expect(contract).not.toContain('Escalation: send_message');
  });

  test('every suggested contract action resolves through the attached worker registry', () => {
    for (const agentName of ['coder', 'reviewer']) {
      const tam = makeManager();
      const names = workerActionNames(tam, agentName);
      const contract = contractOf(tam, agentName, names);
      const suggested = [...contract.matchAll(/invoke\(name="([a-z_]+)"\)/g)].map(
        (match) => match[1]
      );
      for (const name of suggested) {
        expect(names.has(name)).toBe(true);
      }
    }
    const reviewerNames = workerActionNames(makeManager(), 'reviewer');
    const reviewerContract = contractOf(makeManager(), 'reviewer', reviewerNames);
    expect(reviewerContract).toContain('invoke(name="save_artifact"');
  });

  test('worker action names carry operations the action registry no longer defines', () => {
    const tam = makeManager([sendMessageOperation()]);
    const names = workerActionNames(tam);
    const actions = tam.workerActionRegistryFor(SUB_SESSION_ID);
    expect(actions?.entries.some((entry) => entry.name === 'send_message')).toBe(false);
    expect(names.has('send_message')).toBe(true);
  });

  test('the contract still suggests send_message once it is only an operation', () => {
    const tam = makeManager([sendMessageOperation()]);
    const contract = contractOf(tam, 'coder', workerActionNames(tam));
    expect(contract).toContain('invoke(name="send_message")');
  });

  test('the QA contract suggests session.get now that the seed is an operation', () => {
    const tam = makeManager([sessionGetOperation()]);
    const contract = contractOf(tam, 'qa', workerActionNames(tam, 'qa'));
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
  test('attachWorkerOperations installs the worker actions on the session and marks it', () => {
    const tam = makeManager();
    buildServers(tam);
    const fake = makeFakeSession();
    expect(hasRuntimeWorkerOperations(fake.state.session.config)).toBe(false);

    tam.attachWorkerOperations(fake.agentSession);

    const names = tam.workerActionNamesFor(SUB_SESSION_ID);
    expect(names?.size).toBeGreaterThan(0);
    const installed = new Set(fake.state.providers.at(-1)!().entries.map((entry) => entry.name));
    for (const name of names!) expect(installed.has(name)).toBe(true);
    expect(hasRuntimeWorkerOperations(fake.state.session.config)).toBe(true);
    expect(fake.state.session.config.mcpServers).toEqual({});
  });

  test('attachWorkerOperations leaves a session with no worker registry untouched', () => {
    const tam = makeManager();
    const fake = makeFakeSession();

    tam.attachWorkerOperations(fake.agentSession);

    expect(fake.state.providers).toEqual([]);
    expect(hasRuntimeWorkerOperations(fake.state.session.config)).toBe(false);
  });

  test('reinject re-installs the worker operations on the healed session', async () => {
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
    expect(fake.state.providers).toHaveLength(1);
    expect(hasRuntimeWorkerOperations(fake.state.session.config)).toBe(true);
  });

  test('stopping a sub-session evicts its worker registry with the rest of its bookkeeping', async () => {
    const tam = makeManager();
    buildServers(tam);
    expect(tam.workerActionRegistryFor(SUB_SESSION_ID)).toBeDefined();
    const fake = makeFakeSession();

    await (
      tam as unknown as {
        stopSessionPreserveDb: (sessionId: string, session: AgentSession) => Promise<void>;
      }
    ).stopSessionPreserveDb(SUB_SESSION_ID, fake.agentSession);

    expect(fake.state.calls).toEqual(['handleInterrupt', 'cleanup']);
    expect(tam.workerActionRegistryFor(SUB_SESSION_ID)).toBeUndefined();
    expect(tam.workerActionNamesFor(SUB_SESSION_ID)).toBeUndefined();
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
