/**
 * Unit test for TaskAgentManager's Runtime Execution Contract.
 *
 * The contract is private, but the escalation target line is load-bearing:
 * workflow slot prompts refer to it by name, so we verify it is rendered for
 * both workflow and fallback (no-workflow) sessions.
 */

import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { SpaceWorkflow, NodeExecution, Space } from '@hyperneo/shared';

describe('TaskAgentManager Runtime Execution Contract', () => {
  describe('interruptBySessionId boolean contract', () => {
    test('returns true for an unknown session (nothing to interrupt — rows retire)', async () => {
      const manager = makeManager();
      const result = await manager.interruptBySessionId('no-such-session');
      expect(result).toBe(true);
    });

    test('returns true on a successful interrupt and false when handleInterrupt throws', async () => {
      const manager = makeManager();
      const okSession = {
        handleInterrupt: async () => {
          /* succeeds */
        },
      };
      const throwingSession = {
        handleInterrupt: async () => {
          throw new Error('interrupt failed');
        },
      };
      const index = (manager as unknown as { agentSessionIndex: Map<string, unknown> })
        .agentSessionIndex;
      index.set('ok-session', okSession);
      index.set('throwing-session', throwingSession);

      expect(await manager.interruptBySessionId('ok-session')).toBe(true);
      expect(await manager.interruptBySessionId('throwing-session')).toBe(false);
    });
  });

  function makeManager(): TaskAgentManager {
    const db = new BunDatabase(':memory:');
    // The contract builder only reads from the provided workflow/execution/space
    // in this test; all other config fields can be stubbed.
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
