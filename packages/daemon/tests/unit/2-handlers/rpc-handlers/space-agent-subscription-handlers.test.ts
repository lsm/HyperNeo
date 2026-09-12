import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, SpaceLongHorizonAgentEventSubscription } from '@hyperneo/shared';
import { setupSpaceAgentSubscriptionHandlers } from '../../../../src/lib/rpc-handlers/space-agent-subscription-handlers';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentSubscriptionRepository } from '../../../../src/storage/repositories/space-agent-subscription-repository';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

async function call<T>(
  handlers: Map<string, RequestHandler>,
  method: string,
  params: unknown
): Promise<T> {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`Handler not registered: ${method}`);
  return (await handler(params, {})) as T;
}

function seedAgent(db: BunDatabase, id: string, spaceId: string, handle: string): void {
  db.prepare(
    `INSERT INTO space_long_horizon_agents
       (id, space_id, handle, display_name, status, autonomy_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 2, ?, ?)`
  ).run(id, spaceId, handle, handle, Date.now(), Date.now());
}

describe('spaceAgentSubscription RPC handlers', () => {
  let db: BunDatabase;
  let repo: SpaceAgentSubscriptionRepository;
  let hubData: ReturnType<typeof createMockMessageHub>;
  let refreshMock: ReturnType<typeof mock>;
  let removeMock: ReturnType<typeof mock>;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    for (const id of ['space-1', 'space-2']) {
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, id, `/tmp/${id}`, id, Date.now(), Date.now());
    }
    seedAgent(db, 'agent-1', 'space-1', 'researcher');
    seedAgent(db, 'agent-2', 'space-2', 'reviewer');
    const agents = new SpaceAgentRepository(db);
    repo = new SpaceAgentSubscriptionRepository(db, agents);
    refreshMock = mock(() => ({ success: true }));
    removeMock = mock(() => {});
    hubData = createMockMessageHub();
    setupSpaceAgentSubscriptionHandlers(hubData.hub, {
      subscriptions: repo,
      agents,
      runtimeService: {
        refreshLongHorizonSubscription: refreshMock,
        removeLongHorizonSubscription: removeMock,
      } as never,
    });
  });

  afterEach(() => {
    db.close();
    mock.restore();
  });

  it('registers every route under the spaceAgentSubscription prefix', () => {
    expect([...hubData.handlers.keys()].sort()).toEqual([
      'spaceAgentSubscription.create',
      'spaceAgentSubscription.delete',
      'spaceAgentSubscription.list',
      'spaceAgentSubscription.update',
    ]);
  });

  describe('create', () => {
    it('stores a subscription and refreshes the runtime', async () => {
      const result = await call<{ subscription: SpaceLongHorizonAgentEventSubscription }>(
        hubData.handlers,
        'spaceAgentSubscription.create',
        { spaceId: 'space-1', agentId: 'agent-1', source: 'github', topic: 'pull_request.*' }
      );

      expect(result.subscription.source).toBe('github');
      expect(refreshMock).toHaveBeenCalledWith('space-1', result.subscription.id);
    });

    it('trims source and topic before storing', async () => {
      const result = await call<{ subscription: SpaceLongHorizonAgentEventSubscription }>(
        hubData.handlers,
        'spaceAgentSubscription.create',
        { spaceId: 'space-1', agentId: 'agent-1', source: '  github  ', topic: '  repo.*  ' }
      );

      expect(result.subscription.source).toBe('github');
      expect(result.subscription.topic).toBe('repo.*');
    });

    it('rejects a duplicate pattern for the same agent', async () => {
      await call(hubData.handlers, 'spaceAgentSubscription.create', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'repo.*',
      });

      await expect(
        call(hubData.handlers, 'spaceAgentSubscription.create', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'repo.*',
        })
      ).rejects.toThrow(/duplicates existing subscription/);
    });

    it.each([
      ['spaceId', { agentId: 'agent-1', source: 'github', topic: 'repo.*' }, 'spaceId is required'],
      ['agentId', { spaceId: 'space-1', source: 'github', topic: 'repo.*' }, 'agentId is required'],
      ['source', { spaceId: 'space-1', agentId: 'agent-1', topic: 'repo.*' }, 'source is required'],
      ['topic', { spaceId: 'space-1', agentId: 'agent-1', source: 'github' }, 'topic is required'],
    ])('requires %s', async (_name, params, message) => {
      await expect(call(hubData.handlers, 'spaceAgentSubscription.create', params)).rejects.toThrow(
        message
      );
    });

    it('surfaces a failed runtime refresh', async () => {
      refreshMock.mockImplementation(() => ({ success: false, error: 'boom' }));

      await expect(
        call(hubData.handlers, 'spaceAgentSubscription.create', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'repo.*',
        })
      ).rejects.toThrow('boom');
    });
  });

  describe('list', () => {
    it('returns the agent subscriptions', async () => {
      await call(hubData.handlers, 'spaceAgentSubscription.create', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'repo.*',
      });

      const result = await call<{ subscriptions: SpaceLongHorizonAgentEventSubscription[] }>(
        hubData.handlers,
        'spaceAgentSubscription.list',
        { agentId: 'agent-1' }
      );

      expect(result.subscriptions).toHaveLength(1);
    });

    it('requires an agentId', async () => {
      await expect(call(hubData.handlers, 'spaceAgentSubscription.list', {})).rejects.toThrow(
        'agentId is required'
      );
    });

    it('rejects an unknown agent', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentSubscription.list', { agentId: 'nope' })
      ).rejects.toThrow('Agent not found: nope');
    });

    it('rejects a spaceId that does not match the agent', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentSubscription.list', {
          agentId: 'agent-1',
          spaceId: 'space-2',
        })
      ).rejects.toThrow('Agent agent-1 does not belong to space space-2');
    });
  });

  describe('update', () => {
    it('patches the status without touching source or topic', async () => {
      const created = await call<{ subscription: SpaceLongHorizonAgentEventSubscription }>(
        hubData.handlers,
        'spaceAgentSubscription.create',
        { spaceId: 'space-1', agentId: 'agent-1', source: 'github', topic: 'repo.*' }
      );

      const result = await call<{ subscription: SpaceLongHorizonAgentEventSubscription }>(
        hubData.handlers,
        'spaceAgentSubscription.update',
        { subscriptionId: created.subscription.id, status: 'paused' }
      );

      expect(result.subscription.status).toBe('paused');
      expect(result.subscription.source).toBe('github');
    });

    it('requires a subscriptionId', async () => {
      await expect(call(hubData.handlers, 'spaceAgentSubscription.update', {})).rejects.toThrow(
        'subscriptionId is required'
      );
    });

    it('rejects an unknown subscription', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentSubscription.update', { subscriptionId: 'nope' })
      ).rejects.toThrow('Subscription not found: nope');
    });

    it('rejects a mismatched spaceId', async () => {
      const created = await call<{ subscription: SpaceLongHorizonAgentEventSubscription }>(
        hubData.handlers,
        'spaceAgentSubscription.create',
        { spaceId: 'space-1', agentId: 'agent-1', source: 'github', topic: 'repo.*' }
      );

      await expect(
        call(hubData.handlers, 'spaceAgentSubscription.update', {
          subscriptionId: created.subscription.id,
          spaceId: 'space-2',
        })
      ).rejects.toThrow('does not belong to space space-2');
    });
  });

  describe('delete', () => {
    it('removes the subscription and the runtime route', async () => {
      const created = await call<{ subscription: SpaceLongHorizonAgentEventSubscription }>(
        hubData.handlers,
        'spaceAgentSubscription.create',
        { spaceId: 'space-1', agentId: 'agent-1', source: 'github', topic: 'repo.*' }
      );

      await call(hubData.handlers, 'spaceAgentSubscription.delete', {
        subscriptionId: created.subscription.id,
      });

      expect(removeMock).toHaveBeenCalledWith('space-1', created.subscription.id);
      expect(repo.getSubscription(created.subscription.id)).toBeNull();
    });

    it('requires a subscriptionId', async () => {
      await expect(call(hubData.handlers, 'spaceAgentSubscription.delete', {})).rejects.toThrow(
        'subscriptionId is required'
      );
    });

    it('rejects an unknown subscription', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentSubscription.delete', { subscriptionId: 'nope' })
      ).rejects.toThrow('Subscription not found: nope');
    });
  });
});
