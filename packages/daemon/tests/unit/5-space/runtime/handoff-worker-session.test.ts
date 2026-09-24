import { describe, expect, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import { createHandoffWorkerSessionOperation } from '../../../../src/lib/tasks/handoff-worker-session.ts';

const task = {
  id: 'task-1',
  spaceId: 'space-1',
  workflowRunId: 'run-1',
  status: 'blocked',
  blockReason: 'agent_handoff_required',
} as SpaceTask;

describe('task.workerSession.handoff', () => {
  test('only the human RPC caller can authorize a successor', async () => {
    const calls: string[] = [];
    const operation = createHandoffWorkerSessionOperation({
      getTask: () => task,
      handoff: async (_spaceId, taskId) => {
        calls.push(taskId);
        return task;
      },
    });

    expect(await operation.execute({ taskId: task.id }, { source: 'mcp' })).toBe('handoff_denied');
    expect(calls).toEqual([]);
    expect(await operation.execute({ taskId: task.id }, { source: 'rpc' })).toBe(task);
    expect(calls).toEqual(['task-1']);
  });

  test('rejects a task without a handoff-required block', async () => {
    const operation = createHandoffWorkerSessionOperation({
      getTask: () => ({ ...task, blockReason: 'execution_failed' }),
      handoff: async () => task,
    });
    expect(await operation.execute({ taskId: task.id }, { source: 'rpc' })).toBe(
      'handoff_unavailable'
    );
  });
});
