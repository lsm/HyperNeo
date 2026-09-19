import { afterEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  clearAllRetryableHookActionTimers,
  triggerRetryableHookAction,
} from '../../../../src/lib/hooks/hook-binding.ts';
import { WorkflowHookStateRepository } from '../../../../src/storage/repositories/workflow-hook-state-repository.ts';
import { QUEUED_RETRYABLE_ACTION_STATE_KEY } from '../../../../src/lib/hooks/hook-engine.ts';
import { createSpaceTables } from '../../helpers/space-test-db';
import type { WorkflowHook } from '@hyperneo/shared';

const SPACE_ID = 'space-hook-retry';
const RUN_ID = 'run-hook-retry';
const TASK_ID = 'task-hook-retry';
const EXEC_ID = 'exec-hook-retry';
const NODE_ID = 'node-coder';
const AGENT = 'coder';
const SUB_SESSION_ID = `space:${SPACE_ID}:task:${TASK_ID}:exec:${EXEC_ID}`;
const HOOK_ID = 'hook-retry-1';

const hook = {
  id: HOOK_ID,
  enabled: true,
  sourceNode: 'Coding',
  method: 'send_message',
  classification: 'validation',
  order: 0,
  validator: { kind: 'script', interpreter: 'bash', source: 'echo \'{"type":"allow"}\'' },
  authorizedCallers: [{ sourceNode: 'Coding', agentSlots: [AGENT] }],
} as unknown as WorkflowHook;

const workflow = {
  id: 'wf-hook-retry',
  spaceId: SPACE_ID,
  name: 'Coding',
  hooks: [hook],
  channels: [],
  nodes: [{ id: NODE_ID, name: 'Coding', agents: [{ name: AGENT, agentId: 'agent-coder' }] }],
};

const args = { target: 'reviewer', message: 'ready for review' };

const actionKey = JSON.stringify({
  runScopedTaskId: TASK_ID,
  nodeId: NODE_ID,
  sessionId: SUB_SESSION_ID,
  agentName: AGENT,
  methodName: 'send_message',
  args,
});

function makeManager(db: BunDatabase): TaskAgentManager {
  const execution = {
    id: EXEC_ID,
    workflowRunId: RUN_ID,
    workflowNodeId: NODE_ID,
    agentName: AGENT,
    agentId: 'agent-coder',
    agentSessionId: SUB_SESSION_ID,
    status: 'in_progress',
  };
  const task = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID, taskNumber: 3 };
  const run = { id: RUN_ID, workflowId: workflow.id, status: 'in_progress', createdAt: 1 };
  return new TaskAgentManager({
    db: { getDatabase: () => db },
    internalEventBus: { subscribe: () => () => {}, publish: async () => {} },
    sessionManager: { getOperationRegistry: () => ({ entries: [] }) },
    taskRepo: {
      getTask: () => task,
      getTaskByNumber: () => task,
      listByWorkflowRun: () => [task],
    },
    nodeExecutionRepo: { listByWorkflowRun: () => [execution] },
    workflowRunRepo: { getRun: () => run },
    spaceWorkflowManager: { getWorkflowForRun: () => workflow },
    artifactRepo: {},
    channelCycleRepo: {},
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, autonomyLevel: 3 }) },
    spaceRuntimeService: {
      getSpaceRuntime: () => ({}),
      isWorkflowRunActive: () => true,
      activateWorkflowNode: async () => [],
    },
  } as unknown as TaskAgentManagerConfig);
}

afterEach(() => {
  clearAllRetryableHookActionTimers();
});

describe('queued hook retries survive a restart', () => {
  test('building a node-agent session reschedules its persisted retryable action', () => {
    const db = new BunDatabase(':memory:');
    createSpaceTables(db);
    db.exec('PRAGMA foreign_keys = OFF');
    new WorkflowHookStateRepository(db).ensure(RUN_ID, HOOK_ID, {
      [QUEUED_RETRYABLE_ACTION_STATE_KEY]: {
        actionKey,
        hookId: HOOK_ID,
        methodName: 'send_message',
        args,
        meta: { sessionId: SUB_SESSION_ID, agentName: AGENT, nodeId: NODE_ID, taskId: TASK_ID },
        isFollowUp: false,
        nextRetryAt: Date.now() + 60_000,
        retryAfterMs: 60_000,
        queuedAt: Date.now(),
      },
    });

    expect(triggerRetryableHookAction(actionKey)).toBe(false);

    makeManager(db).buildNodeAgentMcpServersForSession(
      TASK_ID,
      SUB_SESSION_ID,
      AGENT,
      SPACE_ID,
      RUN_ID,
      '/tmp/ws',
      NODE_ID
    );

    expect(triggerRetryableHookAction(actionKey)).toBe(true);
  });
});
