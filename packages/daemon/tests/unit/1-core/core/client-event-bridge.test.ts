import { describe, expect, it, mock } from 'bun:test';
import {
  ClientEventBridge,
  createClientEventBridge,
  type StateBroadcasts,
} from '../../../../src/lib/client-event-bridge';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import type { IClientEventGateway, EventChannel } from '@hyperneo/shared';

describe('ClientEventBridge', () => {
  function buildFixture() {
    const eventHandlers = new Map<string, Function[]>();
    const unsubscribers: string[] = [];

    const internalEventBus = {
      subscribe: mock((event: string, handler: Function) => {
        const existing = eventHandlers.get(event) || [];
        existing.push(handler);
        eventHandlers.set(event, existing);
        return () => {
          unsubscribers.push(event);
          const handlers = eventHandlers.get(event);
          if (handlers) {
            const idx = handlers.indexOf(handler);
            if (idx !== -1) handlers.splice(idx, 1);
            if (handlers.length === 0) eventHandlers.delete(event);
          }
        };
      }),
      publish: mock(async () => {}),
    } as unknown as InternalEventBus<DaemonInternalEventMap>;

    const published: { method: string; data: unknown; channel: EventChannel }[] = [];

    const gateway = {
      publish: mock((method: string, data: unknown, channel: EventChannel) => {
        published.push({ method, data, channel });
      }),
      publishGlobal: mock((method: string, data?: unknown) => {
        published.push({ method, data, channel: { kind: 'global' } });
      }),
    } as unknown as IClientEventGateway;

    const broadcastCalls: { method: string; args: unknown[] }[] = [];
    const broadcasts: StateBroadcasts = {
      broadcastSystemChange: mock(async () => {
        broadcastCalls.push({ method: 'broadcastSystemChange', args: [] });
      }),
      broadcastSessionStateChange: mock(async (sessionId: string) => {
        broadcastCalls.push({ method: 'broadcastSessionStateChange', args: [sessionId] });
      }),
    };

    return {
      internalEventBus,
      gateway,
      eventHandlers,
      published,
      unsubscribers,
      broadcasts,
      broadcastCalls,
    };
  }

  describe('start', () => {
    it('should subscribe to all space bridge events', () => {
      const { internalEventBus, gateway, eventHandlers } = buildFixture();
      const bridge = new ClientEventBridge(internalEventBus, gateway);
      bridge.start();

      expect(eventHandlers.has('space.created')).toBe(true);
      expect(eventHandlers.has('space.updated')).toBe(true);
      expect(eventHandlers.has('space.archived')).toBe(true);
      expect(eventHandlers.has('space.deleted')).toBe(true);
      expect(eventHandlers.has('space.task.created')).toBe(true);
      expect(eventHandlers.has('space.task.updated')).toBe(true);
      expect(eventHandlers.has('space.schedule.updated')).toBe(true);
      expect(eventHandlers.has('space.workflowRun.created')).toBe(true);
      expect(eventHandlers.has('space.workflowRun.updated')).toBe(true);
      expect(eventHandlers.has('space.hookState.updated')).toBe(true);
      expect(eventHandlers.has('space.artifactCache.updated')).toBe(true);
      expect(eventHandlers.has('space.pendingMessage.queued')).toBe(true);
      expect(eventHandlers.has('space.pendingMessage.delivered')).toBe(true);
      expect(eventHandlers.has('space.workflowRun.cyclesReset')).toBe(true);
      expect(eventHandlers.has('spaceAgent.created')).toBe(true);
      expect(eventHandlers.has('spaceAgent.updated')).toBe(true);
      expect(eventHandlers.has('spaceAgent.deleted')).toBe(true);
      expect(eventHandlers.has('spaceWorkflow.created')).toBe(true);
      expect(eventHandlers.has('spaceWorkflow.updated')).toBe(true);
      expect(eventHandlers.has('spaceWorkflow.deleted')).toBe(true);
    });

    it('should subscribe to session bridge events', () => {
      const { internalEventBus, gateway, eventHandlers } = buildFixture();
      const bridge = new ClientEventBridge(internalEventBus, gateway);
      bridge.start();

      expect(eventHandlers.has('session.created')).toBe(true);
      expect(eventHandlers.has('session.deleted')).toBe(true);
      expect(eventHandlers.has('context.updated')).toBe(true);
      expect(eventHandlers.has('messages.statusChanged')).toBe(true);
    });

    it('should subscribe to connection/auth bridge events', () => {
      const { internalEventBus, gateway, eventHandlers } = buildFixture();
      const bridge = new ClientEventBridge(internalEventBus, gateway);
      bridge.start();

      expect(eventHandlers.has('api.connection')).toBe(true);
      expect(eventHandlers.has('auth.changed')).toBe(true);
    });

    it('should subscribe to config bridge events', () => {
      const { internalEventBus, gateway, eventHandlers } = buildFixture();
      const bridge = new ClientEventBridge(internalEventBus, gateway);
      bridge.start();

      expect(eventHandlers.has('commands.updated')).toBe(true);
    });

    it('should subscribe to error bridge events', () => {
      const { internalEventBus, gateway, eventHandlers } = buildFixture();
      const bridge = new ClientEventBridge(internalEventBus, gateway);
      bridge.start();

      expect(eventHandlers.has('session.error')).toBe(true);
      expect(eventHandlers.has('session.errorClear')).toBe(true);
    });

    it('should subscribe to provider bridge events', () => {
      const { internalEventBus, gateway, eventHandlers } = buildFixture();
      const bridge = new ClientEventBridge(internalEventBus, gateway);
      bridge.start();

      expect(eventHandlers.has('providers.changed')).toBe(true);
    });

    it('should be idempotent', () => {
      const { internalEventBus, gateway, eventHandlers } = buildFixture();
      const bridge = new ClientEventBridge(internalEventBus, gateway);
      bridge.start();
      bridge.start();

      expect(eventHandlers.size).toBe(34);
    });
  });

  describe('stop', () => {
    it('should unsubscribe from all events', () => {
      const { internalEventBus, gateway, unsubscribers } = buildFixture();
      const bridge = new ClientEventBridge(internalEventBus, gateway);
      bridge.start();
      bridge.stop();

      expect(unsubscribers.length).toBe(35);
    });
  });

  describe('space event forwarding', () => {
    it('forwards space.created to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'global', spaceId: 's-1', space: { id: 's-1' } };
      eventHandlers.get('space.created')![0](data);

      expect(published[0].method).toBe('space.created');
      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.updated to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'global', spaceId: 's-1', space: { name: 'Updated' } };
      eventHandlers.get('space.updated')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.archived to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        space: { id: 's-1', status: 'archived' },
      };
      eventHandlers.get('space.archived')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.deleted to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'global', spaceId: 's-1' };
      eventHandlers.get('space.deleted')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.task.created to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        taskId: 't-1',
        task: { id: 't-1', title: 'Task 1' },
      };
      eventHandlers.get('space.task.created')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.task.updated to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        taskId: 't-1',
        task: { id: 't-1', status: 'in_progress' },
      };
      eventHandlers.get('space.task.updated')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.schedule.updated to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        scheduleId: 'sch-1',
        schedule: { id: 'sch-1', cron: '0 9 * * *' },
      };
      eventHandlers.get('space.schedule.updated')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.workflowRun.created to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        runId: 'run-1',
        run: { id: 'run-1', status: 'pending' },
      };
      eventHandlers.get('space.workflowRun.created')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.workflowRun.updated to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        runId: 'run-1',
        run: { status: 'running' },
      };
      eventHandlers.get('space.workflowRun.updated')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.hookState.updated to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        runId: 'run-1',
        hookId: 'hook-1',
        hookState: {
          runId: 'run-1',
          hookId: 'hook-1',
          version: 1,
          localState: {},
          retryCount: 0,
          voteMaps: {},
          createdAt: 1,
          updatedAt: 2,
        },
      };
      eventHandlers.get('space.hookState.updated')![0](data);

      expect(published[0].method).toBe('space.hookState.updated');
      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.artifactCache.updated to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        taskId: 'task-1',
      };
      eventHandlers.get('space.artifactCache.updated')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards pending-message lifecycle events to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      eventHandlers.get('space.pendingMessage.queued')![0]({
        sessionId: 'global',
        spaceId: 's-1',
        workflowRunId: 'run-1',
        taskId: 'task-1',
        messageId: 'msg-1',
      });
      eventHandlers.get('space.pendingMessage.delivered')![0]({
        sessionId: 'global',
        spaceId: 's-1',
        workflowRunId: 'run-1',
        taskId: 'task-1',
        messageId: 'msg-1',
      });

      expect(published[0].method).toBe('space.pendingMessage.queued');
      expect(published[0].channel).toEqual({ kind: 'global' });
      expect(published[1].method).toBe('space.pendingMessage.delivered');
      expect(published[1].channel).toEqual({ kind: 'global' });
    });

    it('forwards space.workflowRun.cyclesReset to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        workflowRunId: 'run-1',
        channelId: 'ch-1',
      };
      eventHandlers.get('space.workflowRun.cyclesReset')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards spaceAgent.created to space-scoped channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'space:s-1',
        spaceId: 's-1',
        agent: { id: 'a-1', name: 'Agent 1' },
      };
      eventHandlers.get('spaceAgent.created')![0](data);

      expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
    });

    it('forwards spaceAgent.updated to space-scoped channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'space:s-1',
        spaceId: 's-1',
        agent: { id: 'a-1', name: 'Updated Agent' },
      };
      eventHandlers.get('spaceAgent.updated')![0](data);

      expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
    });

    it('forwards spaceAgent.deleted to space-scoped channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'space:s-1', spaceId: 's-1', agentId: 'a-1' };
      eventHandlers.get('spaceAgent.deleted')![0](data);

      expect(published[0].channel).toEqual({ kind: 'space', spaceId: 's-1' });
    });

    it('forwards spaceWorkflow.created to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        workflow: { id: 'wf-1', name: 'Workflow 1' },
      };
      eventHandlers.get('spaceWorkflow.created')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards spaceWorkflow.updated to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'global',
        spaceId: 's-1',
        workflow: { id: 'wf-1', name: 'Updated Workflow' },
      };
      eventHandlers.get('spaceWorkflow.updated')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards spaceWorkflow.deleted to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'global', spaceId: 's-1', workflowId: 'wf-1' };
      eventHandlers.get('spaceWorkflow.deleted')![0](data);

      expect(published[0].channel).toEqual({ kind: 'global' });
    });
  });

  describe('session event forwarding', () => {
    it('forwards session.created to global channel with transformed payload', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = {
        sessionId: 'sess-1',
        session: { id: 'sess-1', title: 'Test', status: 'active', metadata: {} },
      };
      eventHandlers.get('session.created')![0](data);

      expect(published[0].method).toBe('session.created');
      expect(published[0].data).toEqual({ sessionId: 'sess-1' });
      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards session.deleted to global channel with transformed payload', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'sess-1' };
      eventHandlers.get('session.deleted')![0](data);

      expect(published[0].method).toBe('session.deleted');
      expect(published[0].data).toEqual({ sessionId: 'sess-1' });
      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards context.updated to session-scoped channel with transformed payload', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const contextInfo = { files: 5, tokens: 1000 };
      const data = { sessionId: 'sess-1', contextInfo };
      eventHandlers.get('context.updated')![0](data);

      expect(published[0].method).toBe('context.updated');
      expect(published[0].data).toEqual(contextInfo);
      expect(published[0].channel).toEqual({ kind: 'session', sessionId: 'sess-1' });
    });

    it('forwards providers.changed to global channel', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'global' };
      eventHandlers.get('providers.changed')![0](data);

      expect(published[0].method).toBe('providers.changed');
      expect(published[0].data).toEqual(data);
      expect(published[0].channel).toEqual({ kind: 'global' });
    });

    it('forwards messages.statusChanged to global channel with sessionId-only payload', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'sess-1', messageIds: ['msg-1', 'msg-2'], status: 'consumed' };
      eventHandlers.get('messages.statusChanged')![0](data);

      expect(published[0].method).toBe('messages.statusChanged');
      expect(published[0].data).toEqual({ sessionId: 'sess-1' });
      expect(published[0].channel).toEqual({ kind: 'global' });
    });
  });

  describe('connection/auth event forwarding', () => {
    it('triggers broadcastSystemChange on api.connection', async () => {
      const { internalEventBus, eventHandlers, broadcasts, broadcastCalls } = buildFixture();
      createClientEventBridge(internalEventBus, {} as IClientEventGateway, broadcasts).start();

      const data = { sessionId: 'global', status: 'disconnected', timestamp: Date.now() };
      await eventHandlers.get('api.connection')![0](data);

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].method).toBe('broadcastSystemChange');
    });

    it('triggers broadcastSystemChange on auth.changed', async () => {
      const { internalEventBus, eventHandlers, broadcasts, broadcastCalls } = buildFixture();
      createClientEventBridge(internalEventBus, {} as IClientEventGateway, broadcasts).start();

      const data = { sessionId: 'global', method: 'api_key', isAuthenticated: true };
      await eventHandlers.get('auth.changed')![0](data);

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].method).toBe('broadcastSystemChange');
    });
  });

  describe('config event forwarding', () => {
    it('triggers broadcastSessionStateChange on commands.updated', async () => {
      const { internalEventBus, eventHandlers, broadcasts, broadcastCalls } = buildFixture();
      createClientEventBridge(internalEventBus, {} as IClientEventGateway, broadcasts).start();

      const data = { sessionId: 'sess-1', commands: ['cmd1', 'cmd2'] };
      await eventHandlers.get('commands.updated')![0](data);

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].method).toBe('broadcastSessionStateChange');
      expect(broadcastCalls[0].args).toEqual(['sess-1']);
    });
  });

  describe('context.updated broadcast trigger', () => {
    it('triggers broadcastSessionStateChange on context.updated', async () => {
      const { internalEventBus, eventHandlers, broadcasts, broadcastCalls } = buildFixture();
      createClientEventBridge(internalEventBus, {} as IClientEventGateway, broadcasts).start();

      const data = { sessionId: 'sess-1', contextInfo: { files: 5, tokens: 1000 } };
      await eventHandlers.get('context.updated')![1](data);

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].method).toBe('broadcastSessionStateChange');
      expect(broadcastCalls[0].args).toEqual(['sess-1']);
    });
  });

  describe('error event forwarding', () => {
    it('triggers broadcastSessionStateChange on session.error', async () => {
      const { internalEventBus, eventHandlers, broadcasts, broadcastCalls } = buildFixture();
      createClientEventBridge(internalEventBus, {} as IClientEventGateway, broadcasts).start();

      const data = { sessionId: 'sess-1', error: 'Something went wrong' };
      await eventHandlers.get('session.error')![0](data);

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].method).toBe('broadcastSessionStateChange');
      expect(broadcastCalls[0].args).toEqual(['sess-1']);
    });

    it('triggers broadcastSessionStateChange on session.errorClear', async () => {
      const { internalEventBus, eventHandlers, broadcasts, broadcastCalls } = buildFixture();
      createClientEventBridge(internalEventBus, {} as IClientEventGateway, broadcasts).start();

      const data = { sessionId: 'sess-1' };
      await eventHandlers.get('session.errorClear')![0](data);

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0].method).toBe('broadcastSessionStateChange');
      expect(broadcastCalls[0].args).toEqual(['sess-1']);
    });
  });

  describe('payload passthrough', () => {
    it('passes the original payload through unchanged', () => {
      const { internalEventBus, gateway, eventHandlers, published } = buildFixture();
      createClientEventBridge(internalEventBus, gateway).start();

      const data = { sessionId: 'global', spaceId: 's-1', space: { id: 's-1', name: 'Test' } };
      eventHandlers.get('space.created')![0](data);

      expect(published[0].data).toEqual(data);
    });
  });
});
