import { describe, expect, mock, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { SpaceWorkflow, NodeExecution, Space } from '@hyperneo/shared';

describe('TaskAgentManager Runtime Execution Contract', () => {
  function makeManager(): TaskAgentManager {
    const db = new BunDatabase(':memory:');
    return new TaskAgentManager({
      db: { getDatabase: () => db },
      internalEventBus: { subscribe: () => () => {} },
    } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
  }

  const space: Space = {
    id: 'space-contract-test',
    autonomyLevel: 1,
  } as Space;

  test('includes the centrally injected escalation target when no workflow is present', () => {
    const manager = makeManager();
    const execution: NodeExecution = {
      id: 'exec-1',
      agentName: 'coder',
      workflowNodeId: 'node-1',
    } as NodeExecution;

    const contract = (
      manager as unknown as Record<string, (w: null, e: NodeExecution, s: Space | null) => string>
    ).buildNodeExecutionRuntimeContract(null, execution, space);

    expect(contract).toContain('## Runtime Execution Contract');
    expect(contract).toContain(
      'Escalation: send_message({ target: "space-agent", message }) requests human/space-level judgment'
    );
  });

  test('includes the centrally injected escalation target inside a workflow run', () => {
    const manager = makeManager();
    const workflow: SpaceWorkflow = {
      id: 'wf-1',
      spaceId: space.id,
      name: 'Test Workflow',
      nodes: [
        {
          id: 'node-1',
          name: 'Coding',
          agents: [{ agentId: 'Coder', name: 'coder' }],
        },
      ],
      channels: [],
      gates: [],
      startNodeId: 'node-1',
      endNodeId: 'node-1',
      completionAutonomyLevel: 5,
    } as unknown as SpaceWorkflow;

    const execution: NodeExecution = {
      id: 'exec-2',
      agentName: 'coder',
      workflowNodeId: 'node-1',
    } as NodeExecution;

    const contract = (
      manager as unknown as Record<
        string,
        (w: SpaceWorkflow, e: NodeExecution, s: Space | null) => string
      >
    ).buildNodeExecutionRuntimeContract(workflow, execution, space);

    expect(contract).toContain('Node: "Coding" (node-1)');
    expect(contract).toContain(
      'Escalation: send_message({ target: "space-agent", message }) requests human/space-level judgment'
    );
  });

  describe('listLiveSessionTaskIdsForSpace', () => {
    test('enumerates live sub-session task ids by space-embedded session id prefix', () => {
      const manager = makeManager();
      const internals = manager as unknown as {
        subSessions: Map<string, Map<string, unknown>>;
      };
      const fakeSession = {} as never;
      internals.subSessions.set(
        'task-1',
        new Map<string, unknown>([
          ['space:space-a:task:task-1:exec:exec-1', fakeSession],
          ['space:space-a:task:task-1:exec:exec-2:1', fakeSession],
        ])
      );
      internals.subSessions.set(
        'task-2',
        new Map<string, unknown>([['space:space-a:task:task-2:post-approval:coder', fakeSession]])
      );
      internals.subSessions.set(
        'task-3',
        new Map<string, unknown>([['space:space-b:task:task-3:exec:exec-9', fakeSession]])
      );

      expect(manager.listLiveSessionTaskIdsForSpace('space-a').sort()).toEqual([
        'task-1',
        'task-2',
      ]);
      expect(manager.listLiveSessionTaskIdsForSpace('space-b')).toEqual(['task-3']);
      expect(manager.listLiveSessionTaskIdsForSpace('space-c')).toEqual([]);
    });
  });

  describe('rehydrate skips stopped spaces', () => {
    const SPACE_ID = 'space-rehydrate-stopped';
    const RUN_ID = 'run-rehydrate-stopped';
    const TASK_ID = 'task-rehydrate-stopped';
    const SUB_SESSION_ID = `space:${SPACE_ID}:task:${TASK_ID}:exec:exec-rehydrate-stopped`;

    function makeRehydrateManager(space: Space | null): {
      manager: TaskAgentManager;
      restoreMock: ReturnType<typeof mock>;
      listExecutionsMock: ReturnType<typeof mock>;
    } {
      const task = {
        id: TASK_ID,
        spaceId: SPACE_ID,
        workflowRunId: RUN_ID,
      };
      const execution = {
        id: 'exec-rehydrate-stopped',
        workflowRunId: RUN_ID,
        workflowNodeId: 'node-1',
        agentName: 'coder',
        agentSessionId: SUB_SESSION_ID,
        status: 'in_progress',
      };
      const restoreMock = mock(async () => null);
      const listExecutionsMock = mock(() => [execution]);
      const db = new BunDatabase(':memory:');
      const manager = new TaskAgentManager({
        db: { getDatabase: () => db },
        internalEventBus: { subscribe: () => () => {} },
        taskRepo: {
          listActive: () => [task],
          listByWorkflowRun: () => [task],
        },
        spaceManager: {
          getSpace: async () => space,
        },
        nodeExecutionRepo: {
          listByWorkflowRun: listExecutionsMock,
        },
      } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
      (manager as unknown as { rehydrateSubSession: typeof restoreMock }).rehydrateSubSession =
        restoreMock;
      return { manager, restoreMock, listExecutionsMock };
    }

    test('stopped space in_progress execution sub-session is not restored', async () => {
      const fixture = makeRehydrateManager({ id: SPACE_ID, stopped: true } as Space);

      await fixture.manager.rehydrate();

      expect(fixture.listExecutionsMock).toHaveBeenCalledTimes(0);
      expect(fixture.restoreMock).toHaveBeenCalledTimes(0);
    });

    test('paused space in_progress execution sub-session is still restored', async () => {
      const fixture = makeRehydrateManager({
        id: SPACE_ID,
        stopped: false,
        paused: true,
      } as Space);

      await fixture.manager.rehydrate();

      expect(fixture.restoreMock).toHaveBeenCalledTimes(1);
      expect(fixture.restoreMock).toHaveBeenCalledWith(SUB_SESSION_ID);
    });
  });
});
