import { describe, expect, test } from 'bun:test';
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
});
