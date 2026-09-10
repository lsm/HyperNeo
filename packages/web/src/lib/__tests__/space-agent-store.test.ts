import type { SpaceAgent } from '@hyperneo/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionManager } from '../connection-manager.ts';
import { SpaceAgentStore } from '../space-agent-store.ts';

let eventHandlers: Map<string, Set<(event: unknown) => void>>;
let listResult: SpaceAgent[];
let requests: Array<{ method: string; params: unknown }>;
let failNextRequest: string | null;
let joinedChannels: string[];
let leftChannels: string[];

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fire(event: string, payload: unknown): void {
  eventHandlers.get(event)?.forEach((handler) => {
    handler(payload);
  });
}

function makeAgent(id: string, overrides: Partial<SpaceAgent> = {}): SpaceAgent {
  return {
    id,
    spaceId: 'space-1',
    handle: id,
    displayName: id,
    description: null,
    instructions: '',
    status: 'active',
    sessionId: null,
    autonomyLevel: null,
    model: null,
    provider: null,
    modelPool: null,
    thinkingLevel: null,
    settingSources: null,
    tools: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeMockHub() {
  return {
    request: vi.fn(async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (failNextRequest === method) {
        failNextRequest = null;
        throw new Error('boom');
      }
      if (method === 'spaceAgentV2.list') return { agents: listResult };
      if (method === 'spaceAgentV2.create') {
        const p = params as { displayName?: string };
        return { agent: makeAgent('created', { displayName: p.displayName ?? 'created' }) };
      }
      if (method === 'spaceAgentV2.update') {
        const p = params as { id: string; displayName?: string };
        return { agent: makeAgent(p.id, { displayName: p.displayName ?? p.id }) };
      }
      if (method === 'spaceAgentV2.delete') return { id: (params as { id: string }).id };
      throw new Error(`unexpected method ${method}`);
    }),
    joinChannel: vi.fn(async (channel: string) => {
      joinedChannels.push(channel);
    }),
    leaveChannel: vi.fn(async (channel: string) => {
      leftChannels.push(channel);
    }),
    onEvent: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
      eventHandlers.get(event)?.add(handler);
      return () => eventHandlers.get(event)?.delete(handler);
    }),
  };
}

describe('SpaceAgentStore', () => {
  let store: SpaceAgentStore;
  let hub: ReturnType<typeof makeMockHub>;

  beforeEach(() => {
    eventHandlers = new Map();
    requests = [];
    failNextRequest = null;
    joinedChannels = [];
    leftChannels = [];
    listResult = [];
    hub = makeMockHub();
    vi.spyOn(connectionManager, 'getHubIfConnected').mockReturnValue(
      hub as unknown as ReturnType<typeof connectionManager.getHubIfConnected>
    );
    store = new SpaceAgentStore();
  });

  describe('selectSpace', () => {
    it('loads agents sorted oldest first', async () => {
      listResult = [makeAgent('b', { createdAt: 2 }), makeAgent('a', { createdAt: 1 })];
      await store.selectSpace('space-1');

      expect(store.agents.value.map((a) => a.id)).toEqual(['a', 'b']);
    });

    it('subscribes to the three V2 events', async () => {
      await store.selectSpace('space-1');

      expect([...eventHandlers.keys()].sort()).toEqual([
        'spaceAgentV2.created',
        'spaceAgentV2.deleted',
        'spaceAgentV2.updated',
      ]);
    });

    it('is a no-op when the space is already selected', async () => {
      await store.selectSpace('space-1');
      const before = requests.length;
      await store.selectSpace('space-1');

      expect(requests.length).toBe(before);
    });

    it('drops the previous space subscriptions when switching', async () => {
      await store.selectSpace('space-1');
      await store.selectSpace('space-2');

      fire('spaceAgentV2.created', { spaceId: 'space-1', agent: makeAgent('stale') });
      expect(store.agents.value).toHaveLength(0);
    });

    it('records an error instead of throwing when the list fails', async () => {
      failNextRequest = 'spaceAgentV2.list';
      await store.selectSpace('space-1');

      expect(store.error.value).toBe('boom');
      expect(store.loading.value).toBe(false);
    });

    it('refresh is a no-op with no space selected, so connection recovery can call it blind', async () => {
      await store.refresh();

      expect(requests).toEqual([]);
      expect(store.loading.value).toBe(false);
    });

    it('refresh reloads the selected space, recovering state missed while disconnected', async () => {
      await store.selectSpace('space-1');
      listResult = [makeAgent('added-while-offline')];

      await store.refresh();

      expect(store.agents.value.map((a) => a.id)).toEqual(['added-while-offline']);
    });
  });

  describe('mutations', () => {
    beforeEach(async () => {
      await store.selectSpace('space-1');
    });

    it('create sends the active spaceId and inserts the result', async () => {
      const agent = await store.create({ spaceId: 'ignored', displayName: 'New' });

      expect(requests.at(-1)?.params).toMatchObject({ spaceId: 'space-1', displayName: 'New' });
      expect(store.agents.value.map((a) => a.id)).toContain(agent.id);
    });

    it('update replaces the agent in place', async () => {
      listResult = [makeAgent('a')];
      await store.refresh();

      await store.update('a', { displayName: 'Renamed' });

      expect(store.agents.value).toHaveLength(1);
      expect(store.agents.value[0].displayName).toBe('Renamed');
    });

    it('remove drops the agent', async () => {
      listResult = [makeAgent('a')];
      await store.refresh();

      await store.remove('a');

      expect(store.agents.value).toHaveLength(0);
    });
  });

  describe('events', () => {
    beforeEach(async () => {
      await store.selectSpace('space-1');
    });

    it('created appends an agent from another client', () => {
      fire('spaceAgentV2.created', { spaceId: 'space-1', agent: makeAgent('remote') });

      expect(store.agents.value.map((a) => a.id)).toEqual(['remote']);
    });

    it('updated replaces without duplicating', () => {
      fire('spaceAgentV2.created', { spaceId: 'space-1', agent: makeAgent('remote') });
      fire('spaceAgentV2.updated', {
        spaceId: 'space-1',
        agent: makeAgent('remote', { displayName: 'Changed' }),
      });

      expect(store.agents.value).toHaveLength(1);
      expect(store.agents.value[0].displayName).toBe('Changed');
    });

    it('deleted removes the agent', () => {
      fire('spaceAgentV2.created', { spaceId: 'space-1', agent: makeAgent('remote') });
      fire('spaceAgentV2.deleted', { spaceId: 'space-1', agentId: 'remote' });

      expect(store.agents.value).toHaveLength(0);
    });

    it('ignores events for another space', () => {
      fire('spaceAgentV2.created', { spaceId: 'space-2', agent: makeAgent('other') });

      expect(store.agents.value).toHaveLength(0);
    });

    it('ignores an agent whose spaceId does not match the selection', () => {
      fire('spaceAgentV2.created', {
        spaceId: 'space-1',
        agent: makeAgent('mismatched', { spaceId: 'space-9' }),
      });

      expect(store.agents.value).toHaveLength(0);
    });
  });
  describe('connection and staleness', () => {
    it('retries selection after the hub was unavailable', async () => {
      vi.mocked(connectionManager.getHubIfConnected).mockReturnValueOnce(
        null as unknown as ReturnType<typeof connectionManager.getHubIfConnected>
      );
      await store.selectSpace('space-1');
      expect(eventHandlers.size).toBe(0);

      listResult = [makeAgent('a')];
      await store.selectSpace('space-1');

      expect([...eventHandlers.keys()].length).toBe(3);
      expect(store.agents.value.map((a) => a.id)).toEqual(['a']);
    });

    it('does not write a stale error into the newly selected space', async () => {
      let rejectFirst: (err: Error) => void = () => {};
      hub.request.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
      );

      const pending = store.selectSpace('space-1');
      await tick();
      await store.selectSpace('space-2');
      rejectFirst(new Error('space-1 blew up'));
      await pending;

      expect(store.error.value).toBeNull();
    });

    it('does not clear loading for the new space when a stale request settles', async () => {
      let resolveFirst: (value: { agents: SpaceAgent[] }) => void = () => {};
      hub.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      );

      const pending = store.selectSpace('space-1');
      await tick();
      hub.request.mockImplementationOnce(() => new Promise(() => {}));
      const second = store.selectSpace('space-2');

      resolveFirst({ agents: [] });
      await pending;

      expect(store.loading.value).toBe(true);
      void second;
    });
  });
  describe('generation guards', () => {
    it('a stale request for the same space cannot overwrite the current one', async () => {
      let resolveFirst: (value: { agents: SpaceAgent[] }) => void = () => {};
      hub.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      );

      const first = store.selectSpace('space-1');
      await tick();
      await store.selectSpace('space-2');
      listResult = [makeAgent('final')];
      await store.selectSpace('space-1');

      resolveFirst({ agents: [makeAgent('stale')] });
      await first;

      expect(store.agents.value.map((a) => a.id)).toEqual(['final']);
    });

    it('a stale failure for the same space does not clobber the current error', async () => {
      let rejectFirst: (err: Error) => void = () => {};
      hub.request.mockImplementationOnce(
        () =>
          new Promise((_res, reject) => {
            rejectFirst = reject;
          })
      );

      const first = store.selectSpace('space-1');
      await tick();
      await store.selectSpace('space-2');
      await store.selectSpace('space-1');

      rejectFirst(new Error('stale failure'));
      await first;

      expect(store.error.value).toBeNull();
    });

    it('teardown clears agents, error and loading', async () => {
      listResult = [makeAgent('a')];
      await store.selectSpace('space-1');
      store.error.value = 'something';

      store.teardown();

      expect(store.agents.value).toEqual([]);
      expect(store.error.value).toBeNull();
      expect(store.loading.value).toBe(false);
      expect(store.spaceId.value).toBeNull();
    });

    it('teardown during a pending refresh does not leave the store loading', async () => {
      hub.request.mockImplementationOnce(() => new Promise(() => {}));
      const pending = store.selectSpace('space-1');
      await tick();

      store.teardown();

      expect(store.loading.value).toBe(false);
      void pending;
    });
  });
  describe('space channel membership', () => {
    it('joins the space channel before installing handlers', async () => {
      await store.selectSpace('space-1');
      expect(joinedChannels).toEqual(['space:space-1']);
    });

    it('joins the new channel when switching spaces', async () => {
      await store.selectSpace('space-1');
      await store.selectSpace('space-2');

      expect(joinedChannels).toEqual(['space:space-1', 'space:space-2']);
    });

    it('never leaves the shared space channel, which spaceStore owns', async () => {
      await store.selectSpace('space-1');
      await store.selectSpace('space-2');
      store.teardown();

      expect(leftChannels).toEqual([]);
    });

    it('stops handling events after teardown even though the channel stays joined', async () => {
      await store.selectSpace('space-1');
      store.teardown();

      fire('spaceAgentV2.created', { spaceId: 'space-1', agent: makeAgent('ghost') });

      expect(store.agents.value).toEqual([]);
    });

    it('does not accept a mutation result after teardown', async () => {
      await store.selectSpace('space-1');
      store.teardown();

      store.upsert(makeAgent('late'));

      expect(store.agents.value).toEqual([]);
    });
  });
});
