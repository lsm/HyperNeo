import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import type { McpServerConfig } from '@hyperneo/shared';
import type { SpaceActionsMcpServer } from '../../../../src/lib/space/actions/space-actions-server.ts';

const SPACE_ID = 'space-actions-attach';
const RUN_ID = 'run-actions-attach';
const TASK_ID = 'task-actions-attach';
const EXEC_ID = 'exec-actions-attach';
const SUB_SESSION_ID = `space:${SPACE_ID}:task:${TASK_ID}:exec:${EXEC_ID}`;
const FLAG = 'HYPERNEO_SPACE_ACTIONS_DISPATCHER';

function makeManager(): TaskAgentManager {
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
    taskRepo: {
      getTask: () => task,
      getTaskByNumber: () => task,
      listByWorkflowRun: () => [task],
    },
    nodeExecutionRepo: { listByWorkflowRun: () => [execution] },
    workflowRunRepo: { getRun: () => null },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, autonomyLevel: 3 }) },
  } as unknown as TaskAgentManagerConfig);
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
    session: {
      id: SUB_SESSION_ID,
      config: { mcpServers: {} as Record<string, McpServerConfig> | undefined },
    },
  };
  const agentSession = {
    get session() {
      return state.session;
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

function registryNamesOf(server: SpaceActionsMcpServer): ReadonlySet<string> {
  return new Set(server.registry.entries.map((entry) => entry.name));
}

describe('TaskAgentManager — space-actions dispatcher attach (flag-gated)', () => {
  const previousFlag = process.env[FLAG];

  beforeEach(() => {
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (previousFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previousFlag;
  });

  test('flag off (default): worker servers contain only node-agent', () => {
    const servers = buildServers(makeManager());
    expect(Object.keys(servers)).toEqual(['node-agent']);
  });

  test('flag on: worker servers attach space-actions alongside node-agent', () => {
    process.env[FLAG] = '1';
    const servers = buildServers(makeManager());
    expect(Object.keys(servers).sort()).toEqual(['node-agent', 'space-actions']);
    const spaceActions = servers['space-actions'] as unknown as SpaceActionsMcpServer;
    expect(spaceActions.tools.map((entry) => entry.name)).toEqual(['call_action']);
    expect(spaceActions.registry.get('list_peers')?.family).toBe('node');
    expect(spaceActions.registry.get('list_actions')).toBeDefined();
    expect(spaceActions.registry.get('approve_pending_completion')).toBeUndefined();
  });

  test('flag on: reinject (self-heal rebuild path) merges both servers and restarts the query', async () => {
    process.env[FLAG] = '1';
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
    const merged = fake.state.merged.at(-1)!;
    expect(Object.keys(merged).sort()).toEqual(['node-agent', 'space-actions']);
    expect(fake.state.session.config.mcpServers?.['space-actions']).toBeDefined();
    expect(fake.state.restarted).toBe(1);
  });

  test('flag off: reinject detaches a stale space-actions server merged under a previous flag-on era', async () => {
    const tam = makeManager();
    const fake = makeFakeSession();
    fake.agentSession.mergeRuntimeMcpServers({
      'space-actions': { __stale: true } as unknown as McpServerConfig,
    });
    await tam.reinjectNodeAgentMcpServer(fake.agentSession, {
      taskId: TASK_ID,
      subSessionId: SUB_SESSION_ID,
      agentName: 'coder',
      spaceId: SPACE_ID,
      workflowRunId: RUN_ID,
      workspacePath: '/tmp/ws',
      workflowNodeId: 'node-coder',
    });
    expect(fake.state.session.config.mcpServers?.['node-agent']).toBeDefined();
    expect(fake.state.session.config.mcpServers?.['space-actions']).toBeUndefined();
    expect(fake.state.calls).toContain('detachRuntimeMcpServer:space-actions');
  });

  test('flag off: contract keeps the typed tool list', () => {
    const contract = contractOf(makeManager());
    expect(contract).toContain('Tools available:');
    expect(contract).toContain('send_message({ target, message, data? })');
    expect(contract).not.toContain('call_action');
  });

  test('flag on: contract renders dispatcher guidance with registry-filtered availability above the typed fallback', () => {
    process.env[FLAG] = '1';
    const tam = makeManager();
    const servers = buildServers(tam);
    const names = registryNamesOf(servers['space-actions'] as unknown as SpaceActionsMcpServer);
    const contract = contractOf(tam, 'coder', names);
    expect(contract).toContain(
      'call_action({ name, params? }) on the space-actions server — one dispatcher for every action available to the Coder role'
    );
    expect(contract).toContain('call_action(name="list_actions")');
    expect(contract).toContain('call_action(name="restore_node_agent")');
    expect(contract).toContain('call_action(name="create_standalone_task")');
    expect(contract).not.toContain('call_action(name="update_task")');
    expect(contract).toContain('send_message({ target, message, data? })');
    expect(contract).toContain('restore_node_agent({ reason? })');
    expect(contract).toContain(
      'Escalation: send_message({ target: "space-agent", message }) requests human/space-level judgment'
    );
  });

  test('flag on: every suggested contract action resolves through the attached worker registry', () => {
    process.env[FLAG] = '1';
    for (const agentName of ['coder', 'reviewer']) {
      const tam = makeManager();
      const servers = buildServers(tam, agentName);
      const spaceActions = servers['space-actions'] as unknown as SpaceActionsMcpServer;
      const names = registryNamesOf(spaceActions);
      const contract = contractOf(tam, agentName, names);
      const suggested = [...contract.matchAll(/call_action\(name="([a-z_]+)"\)/g)].map(
        (match) => match[1]
      );
      expect(suggested.length).toBeGreaterThan(0);
      for (const name of suggested) {
        expect(names.has(name)).toBe(true);
      }
    }
  });

  test('flag on without registry names: contract omits suggestions instead of guessing', () => {
    process.env[FLAG] = '1';
    const contract = contractOf(makeManager(), 'coder', undefined);
    expect(contract).toContain(
      'call_action({ name, params? }) on the space-actions server — one dispatcher for every action available to the Coder role'
    );
    expect(contract).toContain('call_action(name="list_actions")');
    expect(contract).not.toContain('Suggested:');
  });
});
