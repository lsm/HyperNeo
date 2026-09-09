import { describe, expect, test } from 'bun:test';
import type {
  NodeExecution,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  WorkflowNode,
} from '@hyperneo/shared';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  isMissingWorkflowAgentError,
  MissingWorkflowAgentError,
} from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';

const SPACE_ID = 'space-spawn-audit-1';
const RUN_ID = 'run-spawn-audit-1';
const TASK_ID = 'task-spawn-audit-1';

function stubTemplateRepo(getByKey: (key: string) => { key: string; instructions: string } | null) {
  return { getByKey };
}

function makeManager(templateRepo: ReturnType<typeof stubTemplateRepo>): TaskAgentManager {
  return new TaskAgentManager({
    db: { getDatabase: () => null, getSession: () => null },
    sessionManager: { registerSession: () => {}, getSession: () => undefined },
    internalEventBus: { subscribe: () => () => {} },
    spaceManager: {
      getSpace: async () => ({
        id: SPACE_ID,
        paused: false,
        stopped: false,
        status: 'active',
      }),
    },
    workflowRunRepo: { getRun: () => null },
    spaceWorkflowManager: { getWorkflowForRun: () => null },
    templateRepo: templateRepo as never,
  } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
}

const ORPHAN_REPO = stubTemplateRepo((key) =>
  key === 'migrated.agent.agent-orphan'
    ? { key, instructions: '' }
    : key === 'worker.swe'
      ? { key, instructions: 'You are the SWE worker.' }
      : null
);

const WORKFLOW = {
  id: 'wf-spawn-audit',
  spaceId: SPACE_ID,
  name: 'Spawn Audit Flow',
  nodes: [
    {
      id: 'node-start',
      name: 'Start',
      agents: [{ agentId: '', templateKey: 'migrated.agent.agent-orphan', name: 'orphan-slot' }],
    },
  ],
} as unknown as SpaceWorkflow;

const START_NODE = WORKFLOW.nodes[0] as WorkflowNode;

const TASK = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID } as unknown as SpaceTask;

const RUN = { id: RUN_ID, workflowId: WORKFLOW.id, spaceId: SPACE_ID } as SpaceWorkflowRun;

const SPACE = { id: SPACE_ID, paused: false, stopped: false, status: 'active' } as never;

function makeExecution(agentName: string): NodeExecution {
  return {
    id: `exec-${agentName}`,
    taskId: TASK_ID,
    workflowRunId: RUN_ID,
    workflowNodeId: START_NODE.id,
    agentName,
    agentId: '',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  } as NodeExecution;
}

describe('TaskAgentManager spawn-boundary template audit', () => {
  test('spawnWorkflowNodeAgentForExecution rejects an empty-instruction orphan slot', async () => {
    const manager = makeManager(ORPHAN_REPO);
    let caught: unknown;
    try {
      await manager.spawnWorkflowNodeAgentForExecution(
        TASK,
        SPACE,
        WORKFLOW,
        RUN,
        makeExecution('orphan-slot')
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingWorkflowAgentError);
    expect(isMissingWorkflowAgentError(caught)).toBe(true);
    const message = (caught as MissingWorkflowAgentError).message;
    expect(message).toContain('migrated.agent.agent-orphan');
    expect(message).toContain('empty instructions');
    expect(message).toContain('orphan-slot');
  });

  test('spawnWorkflowNodeAgentForExecution passes a slot whose customPrompt supplies the prompt', async () => {
    const workflow = {
      ...WORKFLOW,
      nodes: [
        {
          ...START_NODE,
          agents: [
            {
              agentId: '',
              templateKey: 'migrated.agent.agent-orphan',
              name: 'orphan-slot',
              customPrompt: { value: 'Slot-level role instructions.' },
            },
          ],
        },
      ],
    } as unknown as SpaceWorkflow;
    const manager = makeManager(ORPHAN_REPO);
    let caught: unknown;
    try {
      await manager.spawnWorkflowNodeAgentForExecution(
        TASK,
        SPACE,
        workflow,
        RUN,
        makeExecution('orphan-slot')
      );
    } catch (err) {
      caught = err;
    }
    expect(isMissingWorkflowAgentError(caught)).toBe(false);
  });

  test('spawnPostApprovalSubSession rejects a post-approval target bound to an empty-instruction template', async () => {
    const manager = makeManager(ORPHAN_REPO);
    let caught: unknown;
    try {
      await manager.spawnPostApprovalSubSession({
        task: TASK,
        workflow: WORKFLOW,
        targetAgent: 'orphan-slot',
        kickoffMessage: 'Merge the PR.',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingWorkflowAgentError);
    const message = (caught as MissingWorkflowAgentError).message;
    expect(message).toContain('migrated.agent.agent-orphan');
    expect(message).toContain('empty instructions');
  });

  test('spawnPostApprovalSubSession passes a healthy template target through to later stages', async () => {
    const workflow = {
      ...WORKFLOW,
      nodes: [
        {
          ...START_NODE,
          agents: [{ agentId: '', templateKey: 'worker.swe', name: 'coder-slot' }],
        },
      ],
    } as unknown as SpaceWorkflow;
    const manager = makeManager(ORPHAN_REPO);
    let caught: unknown;
    try {
      await manager.spawnPostApprovalSubSession({
        task: TASK,
        workflow,
        targetAgent: 'coder-slot',
        kickoffMessage: 'Merge the PR.',
      });
    } catch (err) {
      caught = err;
    }
    expect(isMissingWorkflowAgentError(caught)).toBe(false);
  });
});
