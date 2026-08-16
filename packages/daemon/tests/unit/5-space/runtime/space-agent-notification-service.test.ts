import { describe, it, expect } from 'bun:test';
import { SpaceAgentNotificationService } from '../../../../src/lib/space/runtime/space-agent-notification-service';
import type { SpaceAgentNotificationServiceConfig } from '../../../../src/lib/space/runtime/space-agent-notification-service';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus';
import type { MessageDeliveryMode } from '@hyperneo/shared';
import type { SessionFactory } from '../../../../src/lib/space/runtime/types';

// ---------------------------------------------------------------------------
// Mock SessionFactory
// ---------------------------------------------------------------------------

interface InjectedCall {
  sessionId: string;
  message: string;
  opts?: { deliveryMode?: MessageDeliveryMode };
}

function makeMockSessionFactory(opts?: {
  injectError?: Error;
}): SessionFactory & { calls: InjectedCall[] } {
  const calls: InjectedCall[] = [];
  const injectError = opts?.injectError;

  const factory: SessionFactory & { calls: InjectedCall[] } = {
    calls,
    injectMessage: async (sessionId, message, injectOpts) => {
      if (injectError) throw injectError;
      calls.push({ sessionId, message, opts: injectOpts });
    },
  };

  return factory;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'spaces:global:session-1';
const SPACE_ID = 'space-abc';
const TIMESTAMP = '2026-03-20T10:00:00.000Z';

function makeService(
  factoryOrOpts?:
    | (SessionFactory & { calls: InjectedCall[] })
    | Parameters<typeof makeMockSessionFactory>[0],
  extra?: Partial<SpaceAgentNotificationServiceConfig>
): {
  service: SpaceAgentNotificationService;
  factory: SessionFactory & { calls: InjectedCall[] };
  bus: InternalEventBus<DaemonInternalEventMap>;
  unsubscribe: () => void;
} {
  let factory: SessionFactory & { calls: InjectedCall[] };
  if (factoryOrOpts && 'calls' in factoryOrOpts) {
    factory = factoryOrOpts as SessionFactory & { calls: InjectedCall[] };
  } else {
    factory = makeMockSessionFactory(factoryOrOpts as Parameters<typeof makeMockSessionFactory>[0]);
  }
  const bus = new InternalEventBus<DaemonInternalEventMap>();
  const service = new SpaceAgentNotificationService({
    internalEventBus: bus,
    sessionFactory: factory,
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    ...extra,
  });
  const unsubscribe = service.subscribe();
  return { service, factory, bus, unsubscribe };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpaceAgentNotificationService', () => {
  describe('space.task.blocked event', () => {
    it('injects a message with [TASK_EVENT] prefix when space.task.blocked is published', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-1',
        reason: 'Agent reported an error',
        timestamp: TIMESTAMP,
      });

      expect(factory.calls).toHaveLength(1);
      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] task_blocked');
    });

    it('injects into the correct session ID', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-1',
        reason: 'Error',
        timestamp: TIMESTAMP,
      });

      expect(factory.calls[0].sessionId).toBe(SESSION_ID);
    });

    it('uses defer delivery mode', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-1',
        reason: 'Error',
        timestamp: TIMESTAMP,
      });

      expect(factory.calls[0].opts?.deliveryMode).toBe('defer');
    });

    it('message includes human-readable text with taskId, spaceId, and reason', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-99',
        reason: 'Unrecoverable build failure',
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('task-99');
      expect(message).toContain(SPACE_ID);
      expect(message).toContain('Unrecoverable build failure');
    });

    it('message includes JSON payload with all event fields', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-42',
        reason: 'Timed out',
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      const json = extractJson(message);
      expect(json.kind).toBe('task_blocked');
      expect(json.spaceId).toBe(SPACE_ID);
      expect(json.taskId).toBe('task-42');
      expect(json.reason).toBe('Timed out');
      expect(json.timestamp).toBe(TIMESTAMP);
    });

    it('message includes autonomy level (default supervised)', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-1',
        reason: 'Error',
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('Autonomy level: 1');
      const json = extractJson(message);
      expect(json.autonomyLevel).toBe(1);
    });

    it('message includes semi_autonomous level when configured', async () => {
      const { factory, bus } = makeService(undefined, { autonomyLevel: 3 });
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-1',
        reason: 'Error',
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('Autonomy level: 3');
      const json = extractJson(message);
      expect(json.autonomyLevel).toBe(3);
    });
  });

  describe('space.workflowRun.blocked event', () => {
    it('formats message correctly', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.workflowRun.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        runId: 'run-55',
        reason: 'Transition condition failed: tests did not pass',
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] workflow_run_blocked');
      expect(message).toContain('run-55');
      expect(message).toContain('Transition condition failed: tests did not pass');

      const json = extractJson(message);
      expect(json.kind).toBe('workflow_run_blocked');
      expect(json.runId).toBe('run-55');
      expect(json.autonomyLevel).toBe(1);
    });
  });

  describe('space.task.timeout event', () => {
    it('formats elapsed time in minutes', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.task.timeout', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-slow',
        elapsedMs: 3600000, // 60 minutes
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] task_timeout');
      expect(message).toContain('60 minute');
      expect(message).toContain('task-slow');

      const json = extractJson(message);
      expect(json.kind).toBe('task_timeout');
      expect(json.elapsedMs).toBe(3600000);
      expect(json.autonomyLevel).toBe(1);
    });
  });

  describe('space.workflowRun.completed event', () => {
    it('does not inject routine workflow completion into space agent chat', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.workflowRun.completed', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        runId: 'run-1',
        status: 'done',
        summary: 'All steps finished. PR #42 merged.',
        timestamp: TIMESTAMP,
      });

      expect(factory.calls).toHaveLength(0);
    });
  });

  describe('space.workflowRun.reopened event', () => {
    it('formats a reopen from done with attribution', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.workflowRun.reopened', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        runId: 'run-rx',
        fromStatus: 'done',
        reason: 'user follow-up message arrived',
        by: 'user',
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] workflow_run_reopened');
      expect(message).toContain("reopened from 'done'");
      expect(message).toContain("back to 'in_progress'");
      expect(message).toContain('user follow-up message arrived');
      expect(message).toContain('(by: user)');

      const json = extractJson(message);
      expect(json.kind).toBe('workflow_run_reopened');
      expect(json.runId).toBe('run-rx');
      expect(json.fromStatus).toBe('done');
      expect(json.by).toBe('user');
      expect(json.autonomyLevel).toBe(1);
    });
  });

  describe('space.workflowRun.deadLoop event', () => {
    it('formats a dead-loop block with the agent pair and rate details', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.workflowRun.deadLoop', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        runId: 'run-dl',
        fromAgent: 'reviewer',
        toTarget: 'coder',
        channelIndex: 1,
        recentCount: 15,
        threshold: 15,
        windowMs: 5 * 60 * 1000,
        reason: 'Cyclic channel from "reviewer" to "coder" is in a dead loop',
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] workflow_dead_loop');
      expect(message).toContain('run-dl');
      expect(message).toContain('"reviewer" → "coder"');
      expect(message).toContain('15 message round-trips');
      expect(message).toContain('within 5 minute(s)');
      expect(message).toContain('next send was blocked');

      const json = extractJson(message);
      expect(json.kind).toBe('workflow_dead_loop');
      expect(json.runId).toBe('run-dl');
      expect(json.fromAgent).toBe('reviewer');
      expect(json.toTarget).toBe('coder');
      expect(json.recentCount).toBe(15);
      expect(json.threshold).toBe(15);
      expect(json.autonomyLevel).toBe(1);
    });

    it('propagates injection failure so the router can retry (unlike fire-and-forget events)', async () => {
      // The dead-loop subscriber uses notifyStrict: a failed injection must
      // surface as a publish rejection so ChannelRouter.notifyDeadLoop skips its
      // dedupe timestamp and retries on the next blocked send.
      const { bus } = makeService({ injectError: new Error('session unavailable') });
      await expect(
        bus.publish('space.workflowRun.deadLoop', {
          sessionId: 'global',
          spaceId: SPACE_ID,
          runId: 'run-dl',
          fromAgent: 'reviewer',
          toTarget: 'coder',
          channelIndex: 1,
          recentCount: 15,
          threshold: 15,
          windowMs: 5 * 60 * 1000,
          reason: 'dead loop',
          timestamp: TIMESTAMP,
        })
      ).rejects.toThrow(/failed with 1 handler failure/);
    });
  });

  describe('space.agent.crashed event', () => {
    it('formats agent crash with [TASK_EVENT] prefix', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.agent.crashed', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-crashed',
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] agent_crash');
      expect(message).toContain('task-crashed');
      expect(message).toContain(SPACE_ID);
      expect(message).toContain('blocked');

      const json = extractJson(message);
      expect(json.kind).toBe('agent_crash');
      expect(json.failureReason).toBe('agentCrash');
      expect(json.taskId).toBe('task-crashed');
      expect(json.spaceId).toBe(SPACE_ID);
      expect(json.autonomyLevel).toBe(1);
    });
  });

  describe('space.workflowRun.retry event', () => {
    it('formats retry message', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.workflowRun.retry', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-retry',
        runId: 'run-retry',
        originalReason: 'Network timeout',
        attemptNumber: 2,
        maxAttempts: 3,
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] task_retry');
      expect(message).toContain('attempt 2/3');
      expect(message).toContain('Network timeout');

      const json = extractJson(message);
      expect(json.kind).toBe('task_retry');
      expect(json.attemptNumber).toBe(2);
      expect(json.maxAttempts).toBe(3);
    });
  });

  describe('space.workflowRun.needsAttention event', () => {
    it('formats needs attention message', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.workflowRun.needsAttention', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        runId: 'run-na',
        taskId: 'task-na',
        reason: 'All retries exhausted',
        retriesExhausted: 3,
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] workflow_run_needs_attention');
      expect(message).toContain('needs attention');
      expect(message).toContain('3');

      const json = extractJson(message);
      expect(json.kind).toBe('workflow_run_needs_attention');
      expect(json.retriesExhausted).toBe(3);
    });
  });

  describe('space.task.awaitingApproval event', () => {
    it('formats awaiting approval message', async () => {
      const { factory, bus } = makeService();
      await bus.publish('space.task.awaitingApproval', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-1',
        actionId: 'merge-pr',
        actionName: 'Merge PR',
        actionDescription: 'Merges the staged PR',
        actionType: 'script',
        requiredLevel: 4,
        spaceLevel: 2,
        autonomyLevel: 2,
        timestamp: TIMESTAMP,
      });

      const { message } = factory.calls[0];
      expect(message).toContain('[TASK_EVENT] task_awaiting_approval');
      expect(message).toContain('task-1');
      expect(message).toContain('space-a');
      expect(message).toContain("'Merge PR'");
      expect(message).toContain('Merges the staged PR');
      expect(message).toContain('Requires autonomy 4');
      expect(message).toContain('space is at 2');

      const json = extractJson(message);
      expect(json.kind).toBe('task_awaiting_approval');
      expect(json.actionId).toBe('merge-pr');
      expect(json.actionName).toBe('Merge PR');
      expect(json.actionDescription).toBe('Merges the staged PR');
      expect(json.actionType).toBe('script');
      expect(json.requiredLevel).toBe(4);
      expect(json.spaceLevel).toBe(2);
      // Service-level autonomy (default 1) is used, not event.autonomyLevel
      expect(json.autonomyLevel).toBe(1);
    });
  });

  describe('error handling', () => {
    it('logs warning and does not throw when injectMessage fails', async () => {
      const { factory, bus } = makeService({ injectError: new Error('Session not found') });

      // Should not throw despite injectMessage failing
      await expect(
        bus.publish('space.task.blocked', {
          sessionId: 'global',
          spaceId: SPACE_ID,
          taskId: 'task-1',
          reason: 'Error',
          timestamp: TIMESTAMP,
        })
      ).resolves.toBeDefined();
    });
  });

  describe('unsubscribe', () => {
    it('stops receiving events after unsubscribe', async () => {
      const { factory, bus, unsubscribe } = makeService();

      // First event should be received
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-1',
        reason: 'Error',
        timestamp: TIMESTAMP,
      });
      expect(factory.calls).toHaveLength(1);

      // Unsubscribe
      unsubscribe();

      // Second event should NOT be received
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-2',
        reason: 'Error 2',
        timestamp: TIMESTAMP,
      });
      expect(factory.calls).toHaveLength(1);
    });
  });

  describe('per-space filtering', () => {
    it('ignores events for other spaces', async () => {
      const { factory, bus } = makeService();

      // Event for the correct space
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: SPACE_ID,
        taskId: 'task-1',
        reason: 'Error',
        timestamp: TIMESTAMP,
      });

      // Event for a different space
      await bus.publish('space.task.blocked', {
        sessionId: 'global',
        spaceId: 'other-space',
        taskId: 'task-2',
        reason: 'Other error',
        timestamp: TIMESTAMP,
      });

      expect(factory.calls).toHaveLength(1);
      expect(factory.calls[0].message).toContain('task-1');
    });
  });
});

// ---------------------------------------------------------------------------
// Test utility: extract the first JSON block from a message
// ---------------------------------------------------------------------------

function extractJson(message: string): Record<string, unknown> {
  const match = message.match(/```json\n([\s\S]*?)```/);
  if (!match) throw new Error(`No JSON block found in message:\n${message}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}
