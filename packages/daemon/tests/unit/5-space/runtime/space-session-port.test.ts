import { describe, expect, it } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { createSpaceSessionPort } from '../../../../../space/src/runtime/space-session-port.ts';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import type { Database } from '../../../../src/storage/sqlite-compat.ts';

const task = { id: 'task-1' };

function port(bound: unknown, byId: unknown) {
  return createSpaceSessionPort(
    {} as Database,
    {
      getTaskBySessionId: () => bound,
      getTask: (id: string) => (id === 'task-1' ? byId : null),
    } as unknown as SpaceTaskRepository,
    {
      getByAgentSessionId: (id: string) => (id === 's1' ? { workflowRunId: 'run-1' } : null),
    } as unknown as NodeExecutionRepository,
    {} as SpaceLongHorizonAgentRepository
  );
}

describe('Space session port', () => {
  it('prefers the task bound to the session', () => {
    const session = { id: 's1', context: {} } as Session;
    expect(port(task, null).taskForSession(session)).toBe(task as never);
  });

  it('falls back to the task named in the session context', () => {
    const session = { id: 's1', context: { taskId: 'task-1' } } as Session;
    expect(port(null, task).taskForSession(session)).toBe(task as never);
  });

  it('returns null without a bound or named task', () => {
    expect(port(null, task).taskForSession({ id: 's1', context: {} } as Session)).toBeNull();
  });

  it('reads the workflow run of the session execution', () => {
    expect(port(null, null).workflowRunIdForSession('s1')).toBe('run-1');
    expect(port(null, null).workflowRunIdForSession('other')).toBeUndefined();
  });
});
