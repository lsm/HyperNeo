import { describe, expect, test } from 'bun:test';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  createDaemonInternalEventBus,
  type DaemonInternalEventMap,
  type InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

function makeManagerWithBus(): {
  manager: TaskAgentManager;
  bus: InternalEventBus<DaemonInternalEventMap>;
} {
  const db = new BunDatabase(':memory:');
  const bus = createDaemonInternalEventBus();
  const manager = new TaskAgentManager({
    db: { getDatabase: () => db },
    internalEventBus: bus,
  } as never);
  return { manager, bus };
}

describe('TaskAgentManager session.providerRouted reconciliation', () => {
  test('rekeys an active pool assignment to the provider the session actually runs', async () => {
    const { manager, bus } = makeManagerWithBus();
    const assignments = (manager as unknown as { modelPoolAssignments: Map<string, unknown> })
      .modelPoolAssignments;
    assignments.set('session-1', {
      spaceId: 'space-1',
      taskId: 'task-1',
      model: 'glm-5',
      provider: 'anthropic',
      assignedAt: 1000,
    });

    await bus.publish('session.providerRouted', {
      sessionId: 'session-1',
      model: 'glm-5',
      provider: 'glm',
    });

    expect(assignments.get('session-1')).toMatchObject({ model: 'glm-5', provider: 'glm' });
  });

  test('leaves unrelated and already-matched assignments untouched', async () => {
    const { manager, bus } = makeManagerWithBus();
    const assignments = (manager as unknown as { modelPoolAssignments: Map<string, unknown> })
      .modelPoolAssignments;
    assignments.set('session-2', {
      spaceId: 'space-1',
      taskId: 'task-1',
      model: 'glm-5',
      provider: 'glm',
      assignedAt: 1000,
    });

    await bus.publish('session.providerRouted', {
      sessionId: 'session-missing',
      model: 'glm-5',
      provider: 'anthropic',
    });
    await bus.publish('session.providerRouted', { sessionId: 'session-2', model: 'glm-5' });

    expect(assignments.get('session-2')).toMatchObject({ provider: 'glm' });
    expect(assignments.has('session-missing')).toBe(false);
  });

  test('applies a route buffered before activation when the assignment activates', async () => {
    const { manager, bus } = makeManagerWithBus();
    const assignments = (manager as unknown as { modelPoolAssignments: Map<string, unknown> })
      .modelPoolAssignments;
    await bus.publish('session.providerRouted', {
      sessionId: 'session-4',
      model: 'glm-5',
      provider: 'glm',
    });
    assignments.set('pending:exec-4', {
      spaceId: 'space-1',
      taskId: 'task-1',
      model: 'glm-5',
      provider: 'anthropic',
      assignedAt: 1000,
      pending: true,
    });

    (
      manager as unknown as {
        activatePoolAssignment: (execution: { id: string }, sessionId: string) => void;
      }
    ).activatePoolAssignment({ id: 'exec-4' }, 'session-4');

    expect(assignments.get('session-4')).toMatchObject({ model: 'glm-5', provider: 'glm' });
    expect(assignments.has('pending:exec-4')).toBe(false);
  });

  test('does not rekey an assignment when the session switched to a different model', async () => {
    const { manager, bus } = makeManagerWithBus();
    const assignments = (manager as unknown as { modelPoolAssignments: Map<string, unknown> })
      .modelPoolAssignments;
    assignments.set('session-3', {
      spaceId: 'space-1',
      taskId: 'task-1',
      model: 'model-a',
      provider: 'anthropic',
      assignedAt: 1000,
    });

    await bus.publish('session.providerRouted', {
      sessionId: 'session-3',
      model: 'model-b',
      provider: 'glm',
    });

    expect(assignments.get('session-3')).toMatchObject({ model: 'model-a', provider: 'anthropic' });
  });
});
