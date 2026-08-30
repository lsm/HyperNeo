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

function buildServers(tam: TaskAgentManager): Record<string, McpServerConfig> {
  return tam.buildNodeAgentMcpServersForSession(
    TASK_ID,
    SUB_SESSION_ID,
    'coder',
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

    restartQuery: async () => {
      state.restarted += 1;
    },
    getSessionData: () => state.session,
  };
  return { agentSession: agentSession as unknown as AgentSession, state };
}

function contractOf(tam: TaskAgentManager): string {
  return (
    tam as unknown as {
      buildNodeExecutionRuntimeContract: (
        w: null,
        e: { agentName: string; workflowNodeId: string },
        s: { autonomyLevel: number } | null
      ) => string;
    }
  ).buildNodeExecutionRuntimeContract(
    null,
    { agentName: 'coder', workflowNodeId: 'node-1' },
    {
      autonomyLevel: 1,
    }
  );
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

  test('flag off: contract keeps the typed tool list', () => {
    const contract = contractOf(makeManager());
    expect(contract).toContain('Tools available:');
    expect(contract).toContain('send_message({ target, message, data? })');
    expect(contract).not.toContain('call_action');
  });

  test('flag on: contract renders the dispatcher variant with per-role availability', () => {
    process.env[FLAG] = '1';
    const contract = contractOf(makeManager());
    expect(contract).toContain(
      'call_action({ name, params? }) on the space-actions server — one dispatcher for every action available to the Coder role'
    );
    expect(contract).toContain('call_action(name="list_actions")');
    expect(contract).toContain('call_action(name="restore_node_agent")');
    expect(contract).toContain(
      'Escalation: send_message({ target: "space-agent", message }) requests human/space-level judgment'
    );
    expect(contract).not.toContain('list_peers / list_reachable_agents — discovery');
  });
});
