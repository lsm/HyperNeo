import { Database as BunDatabase } from 'bun:sqlite';
import { describe, expect, mock, spyOn, test } from 'bun:test';
import { configureLogger, LogLevel, subscribeToStructuredLogs } from '../../../../src/lib/logger';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

const ACTIVATION_TIMEOUT_MS = 30_000;
const SPACE_ID = 'space-activation-timeout';
const RUN_ID = 'run-activation-timeout';
const TASK_ID = 'task-activation-timeout';
const EXEC_ID = 'exec-activation-timeout';
const AGENT_NAME = 'coder';
const SESSION_ID = 'session-spawned-for-race';

describe('TaskAgentManager.activateTargetSessionsForMessage activation timeout', () => {
  function makeManager(spawn: () => Promise<string>): TaskAgentManager {
    const db = new BunDatabase(':memory:');
    const task = { id: TASK_ID, spaceId: SPACE_ID, workflowRunId: RUN_ID };
    const run = { id: RUN_ID, workflowId: 'wf-activation-timeout' };
    const workflow = { id: 'wf-activation-timeout', spaceId: SPACE_ID };
    const execution = {
      id: EXEC_ID,
      agentName: AGENT_NAME,
      workflowNodeId: 'node-1',
      status: 'pending',
    };
    const manager = new TaskAgentManager({
      db: { getDatabase: () => db },
      internalEventBus: { subscribe: () => () => {} },
      taskRepo: { getTask: () => task },
      workflowRunRepo: { getRun: () => run },
      spaceWorkflowManager: { getWorkflowForRun: () => workflow },
      spaceManager: { getSpace: async () => ({ id: SPACE_ID }) },
      nodeExecutionRepo: {
        listByWorkflowRun: () => [execution],
        update: () => {},
      },
    } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
    const internals = manager as unknown as Record<string, unknown>;
    internals.tryResumeNodeAgentSession = async () => undefined;
    internals.ensureWorkflowNodeActivationForAgent = async () => true;
    internals.spawnWorkflowNodeAgentForExecution = spawn;
    return manager;
  }

  function spyActivationTimer(): {
    activationHandle: () => unknown;
    clearedHandles: unknown[];
    unrefSpy: ReturnType<typeof mock>;
    restore: () => void;
  } {
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const unrefSpy = mock(() => {});
    let activationHandle: unknown = null;
    const clearedHandles: unknown[] = [];
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === ACTIVATION_TIMEOUT_MS) {
          activationHandle = { unref: unrefSpy };
          return activationHandle as unknown as ReturnType<typeof setTimeout>;
        }
        return origSetTimeout(fn as () => void, delay ?? 0, ...(args as []));
      }
    );
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(
      (handle?: unknown) => {
        clearedHandles.push(handle);
        if (handle !== activationHandle) {
          origClearTimeout(handle as Parameters<typeof origClearTimeout>[0]);
        }
      }
    );
    return {
      activationHandle: () => activationHandle,
      clearedHandles,
      unrefSpy,
      restore: () => {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      },
    };
  }

  function fireActivationTimeoutAfter(ms: number): { restore: () => void } {
    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) =>
        origSetTimeout(
          fn as () => void,
          delay === ACTIVATION_TIMEOUT_MS ? ms : (delay ?? 0),
          ...(args as [])
        )
    );
    return {
      restore: () => {
        setTimeoutSpy.mockRestore();
      },
    };
  }

  test('clears and unrefs the activation timeout timer after a winning spawn', async () => {
    const timers = spyActivationTimer();
    const manager = makeManager(async () => SESSION_ID);
    try {
      const result = await manager.activateTargetSessionsForMessage(TASK_ID, RUN_ID, AGENT_NAME);
      expect(result).toEqual([{ agentName: AGENT_NAME, sessionId: SESSION_ID }]);
      expect(timers.clearedHandles).toContain(timers.activationHandle());
      expect(timers.unrefSpy).toHaveBeenCalledTimes(1);
    } finally {
      timers.restore();
    }
  });

  test('clears the activation timeout timer when the spawn rejects before the timeout', async () => {
    const timers = spyActivationTimer();
    const manager = makeManager(() => Promise.reject(new Error('early spawn failure')));
    try {
      await expect(
        manager.activateTargetSessionsForMessage(TASK_ID, RUN_ID, AGENT_NAME)
      ).rejects.toThrow('early spawn failure');
      expect(timers.clearedHandles).toContain(timers.activationHandle());
    } finally {
      timers.restore();
    }
  });

  test('times out with [] and logs a late spawn rejection instead of leaving it unhandled', async () => {
    const origSetTimeout = globalThis.setTimeout;
    const timers = fireActivationTimeoutAfter(5);
    let rejectSpawn: ((err: Error) => void) | null = null;
    const controllableSpawn = new Promise<string>((_resolve, reject) => {
      rejectSpawn = reject;
    });
    const manager = makeManager(() => controllableSpawn);
    const events: Array<{ level: string; message: string }> = [];
    const unsubscribe = subscribeToStructuredLogs((event) =>
      events.push({ level: event.level, message: event.message })
    );
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    configureLogger({ level: LogLevel.WARN });
    try {
      const result = await manager.activateTargetSessionsForMessage(TASK_ID, RUN_ID, AGENT_NAME);
      expect(result).toEqual([]);
      expect(
        events.some(
          (event) =>
            event.level === 'warn' &&
            event.message.includes(
              `timed out after ${ACTIVATION_TIMEOUT_MS}ms activating agent "${AGENT_NAME}" for run ${RUN_ID}`
            )
        )
      ).toBe(true);

      rejectSpawn?.(new Error('late spawn failure'));
      await new Promise<void>((resolve) => {
        origSetTimeout(() => resolve(), 50);
      });
      expect(unhandled).toEqual([]);
      expect(
        events.some(
          (event) =>
            event.level === 'warn' &&
            event.message.includes(
              `spawn of agent "${AGENT_NAME}" for run ${RUN_ID} failed: late spawn failure`
            )
        )
      ).toBe(true);
    } finally {
      configureLogger({ level: LogLevel.SILENT });
      process.off('unhandledRejection', onUnhandledRejection);
      unsubscribe();
      timers.restore();
    }
  });
});
