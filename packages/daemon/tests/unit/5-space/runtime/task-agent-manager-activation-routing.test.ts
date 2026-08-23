import { Database as BunDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

const SPACE_ID = 'space-activation-routing';
const RUN_ID = 'run-activation-routing';
const TASK_ID = 'task-activation-routing';
const EXEC_ID = 'exec-activation-routing';
const AGENT_NAME = 'coder';
const LIVE_SESSION_ID = 'session-live';
const DEAD_SESSION_ID = 'session-dead';
const NODE_ID = 'node-1';

interface ActivationRoutingHarness {
  manager: TaskAgentManager;
  updates: Array<{ id: string; params: unknown }>;
  activationCalls: () => number;
  spawnCalls: () => number;
}

function makeManager(input: {
  executionStatus: 'in_progress' | 'blocked' | null;
  agentSessionId: string | null;
  sessionAlive: boolean;
  nodeAgents: Array<{ agentId: string; name: string }>;
}): ActivationRoutingHarness {
  const db = new BunDatabase(':memory:');
  const task = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID };
  const run = { id: RUN_ID, workflowId: 'wf-activation-routing' };
  const workflow = {
    id: 'wf-activation-routing',
    spaceId: SPACE_ID,
    nodes: [{ id: NODE_ID, name: 'work', agents: input.nodeAgents }],
  };
  const execution =
    input.executionStatus === null
      ? null
      : {
          id: EXEC_ID,
          agentName: AGENT_NAME,
          workflowNodeId: NODE_ID,
          agentSessionId: input.agentSessionId,
          status: input.executionStatus,
        };
  const updates: Array<{ id: string; params: unknown }> = [];
  let activationCalls = 0;
  let spawnCalls = 0;
  const manager = new TaskAgentManager({
    db: { getDatabase: () => db },
    internalEventBus: { subscribe: () => () => {} },
    taskRepo: { getTask: () => task },
    workflowRunRepo: { getRun: () => run },
    spaceWorkflowManager: { getWorkflowForRun: () => workflow },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID }) },
    nodeExecutionRepo: {
      listByWorkflowRun: () => (execution ? [execution] : []),
      update: (id: string, params: unknown) => {
        updates.push({ id, params });
      },
      casExecutionStatus: (
        id: string,
        expected: readonly string[],
        next: string
      ): 'won' | 'superseded' => {
        updates.push({ id, params: { status: next, __cas: [...expected] } });
        if (!execution || id !== execution.id || !expected.includes(execution.status)) {
          return 'superseded';
        }
        execution.status = next as typeof execution.status;
        return 'won';
      },
    },
  } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
  const internals = manager as unknown as Record<string, unknown>;
  internals.tryResumeNodeAgentSession = async () => undefined;
  internals.isSessionAlive = () => input.sessionAlive;
  internals.ensureWorkflowNodeActivationForAgent = async () => {
    activationCalls += 1;
    return true;
  };
  internals.spawnWorkflowNodeAgentForExecution = async () => {
    spawnCalls += 1;
    return LIVE_SESSION_ID;
  };
  return {
    manager,
    updates,
    activationCalls: () => activationCalls,
    spawnCalls: () => spawnCalls,
  };
}

describe('TaskAgentManager.activateTargetSessionsForMessage activation routing', () => {
  test('a dead execution for an agent no longer declared on the node resets and returns [] without activating', async () => {
    const harness = makeManager({
      executionStatus: 'in_progress',
      agentSessionId: DEAD_SESSION_ID,
      sessionAlive: false,
      nodeAgents: [{ agentId: 'agent-reviewer', name: 'reviewer' }],
    });
    const result = await harness.manager.activateTargetSessionsForMessage(
      TASK_ID,
      RUN_ID,
      AGENT_NAME,
      { workflowNodeId: NODE_ID }
    );
    expect(result).toEqual([]);
    expect(harness.updates).toEqual([
      { id: EXEC_ID, params: { status: 'pending', __cas: ['in_progress'] } },
    ]);
    expect(harness.activationCalls()).toBe(0);
    expect(harness.spawnCalls()).toBe(0);
  });

  test('an undeclared agent without an existing execution returns [] before activation', async () => {
    const harness = makeManager({
      executionStatus: null,
      agentSessionId: null,
      sessionAlive: false,
      nodeAgents: [{ agentId: 'agent-reviewer', name: 'reviewer' }],
    });
    const result = await harness.manager.activateTargetSessionsForMessage(
      TASK_ID,
      RUN_ID,
      AGENT_NAME,
      { workflowNodeId: NODE_ID }
    );
    expect(result).toEqual([]);
    expect(harness.updates).toEqual([]);
    expect(harness.activationCalls()).toBe(0);
  });

  test('a dead execution for a declared agent is reset, activated, and spawned', async () => {
    const harness = makeManager({
      executionStatus: 'blocked',
      agentSessionId: DEAD_SESSION_ID,
      sessionAlive: false,
      nodeAgents: [{ agentId: 'agent-coder', name: AGENT_NAME }],
    });
    const result = await harness.manager.activateTargetSessionsForMessage(
      TASK_ID,
      RUN_ID,
      AGENT_NAME,
      { workflowNodeId: NODE_ID }
    );
    expect(result).toEqual([{ agentName: AGENT_NAME, sessionId: LIVE_SESSION_ID }]);
    expect(harness.updates).toEqual([
      { id: EXEC_ID, params: { status: 'pending', __cas: ['blocked'] } },
    ]);
    expect(harness.activationCalls()).toBe(1);
    expect(harness.spawnCalls()).toBe(1);
  });

  test('a live session is reused before the node declaration lookup can throw', async () => {
    const harness = makeManager({
      executionStatus: 'in_progress',
      agentSessionId: LIVE_SESSION_ID,
      sessionAlive: true,
      nodeAgents: [],
    });
    const result = await harness.manager.activateTargetSessionsForMessage(
      TASK_ID,
      RUN_ID,
      AGENT_NAME,
      { workflowNodeId: NODE_ID }
    );
    expect(result).toEqual([{ agentName: AGENT_NAME, sessionId: LIVE_SESSION_ID }]);
    expect(harness.updates).toEqual([]);
    expect(harness.activationCalls()).toBe(0);
    expect(harness.spawnCalls()).toBe(0);
  });

  test('a live session for an undeclared agent is still reused', async () => {
    const harness = makeManager({
      executionStatus: 'in_progress',
      agentSessionId: LIVE_SESSION_ID,
      sessionAlive: true,
      nodeAgents: [{ agentId: 'agent-reviewer', name: 'reviewer' }],
    });
    const result = await harness.manager.activateTargetSessionsForMessage(
      TASK_ID,
      RUN_ID,
      AGENT_NAME,
      { workflowNodeId: NODE_ID }
    );
    expect(result).toEqual([{ agentName: AGENT_NAME, sessionId: LIVE_SESSION_ID }]);
    expect(harness.activationCalls()).toBe(0);
  });
});
