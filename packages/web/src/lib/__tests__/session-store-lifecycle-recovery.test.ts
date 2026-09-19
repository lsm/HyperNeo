// @ts-nocheck

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../session-store';
import { Logger } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

const lifecycleHub = {
  request: vi.fn(),
  onEvent: vi.fn(),
  onConnection: vi.fn(),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
  isConnected: vi.fn(() => true),
};

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(lifecycleHub)),
    getHubIfConnected: vi.fn(() => lifecycleHub),
  },
}));

vi.mock('../signals', () => ({
  slashCommandsSignal: { value: [] },
}));

vi.mock('../toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

interface LifecycleHubApi {
  fire: (channel: string, data: unknown) => void;
  fireConnection: (state: string) => void;
  readonly subscriptionId: string | null;
  subscribeCalls: Array<{ queryName: string; subscriptionId: string; params: unknown[] }>;
}

function installLifecycleHub(): LifecycleHubApi {
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const connectionHandlers: Array<(state: string) => void> = [];
  let capturedSubscriptionId: string | null = null;
  const subscribeCalls: LifecycleHubApi['subscribeCalls'] = [];

  lifecycleHub.request.mockImplementation((channel: string, params?: Record<string, unknown>) => {
    if (channel === 'state.session') {
      return Promise.resolve({ sessionInfo: { id: 'session-1' } });
    }
    if (channel === 'liveQuery.subscribe') {
      capturedSubscriptionId = String(params?.subscriptionId ?? '');
      subscribeCalls.push({
        queryName: String(params?.queryName ?? ''),
        subscriptionId: capturedSubscriptionId,
        params: (params?.params as unknown[]) ?? [],
      });
      return Promise.resolve({ subscriptionId: capturedSubscriptionId });
    }
    if (channel === 'liveQuery.unsubscribe') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve(undefined);
  });

  lifecycleHub.onEvent.mockImplementation((channel: string, callback: (data: unknown) => void) => {
    const list = eventHandlers.get(channel) ?? [];
    list.push(callback);
    eventHandlers.set(channel, list);
    return () => {
      const l = eventHandlers.get(channel);
      if (!l) return;
      const i = l.indexOf(callback);
      if (i >= 0) l.splice(i, 1);
    };
  });

  lifecycleHub.onConnection.mockImplementation((callback: (state: string) => void) => {
    connectionHandlers.push(callback);
    return () => {
      const i = connectionHandlers.indexOf(callback);
      if (i >= 0) connectionHandlers.splice(i, 1);
    };
  });

  return {
    fire: (channel, data) => {
      for (const h of eventHandlers.get(channel) ?? []) h(data);
    },
    fireConnection: (state) => {
      for (const h of connectionHandlers) h(state);
    },
    get subscriptionId() {
      return capturedSubscriptionId;
    },
    subscribeCalls,
  };
}

describe('chat/thread lifecycle recovery — SessionStore', () => {
  let hub: LifecycleHubApi;

  beforeEach(() => {
    vi.clearAllMocks();
    hub = installLifecycleHub();
  });

  afterEach(async () => {
    await sessionStore.select(null);
  });

  it('traces received row IDs and the exact guard that discards each delta without message contents', async () => {
    const trace = vi.spyOn(Logger.prototype, 'debugWithMetadata').mockImplementation(() => {});
    try {
      await sessionStore.select('session-1');
      const subscriptionId = hub.subscriptionId;
      const row = {
        id: 'assistant-secret',
        type: 'assistant',
        message: { content: 'private answer' },
      };
      hub.fire('liveQuery.delta', { subscriptionId, added: [row], version: 1 });
      expect(sessionStore.sdkMessages.value).toHaveLength(0);
      expect(trace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subscriptionId,
          outcome: 'awaiting_snapshot',
          addedIds: ['assistant-secret'],
          version: 1,
        }),
        'messages.liveQuery'
      );

      hub.fire('liveQuery.snapshot', { subscriptionId, rows: [], version: 2 });
      hub.fire('liveQuery.delta', { subscriptionId, added: [row], version: 3, rowCount: 1 });
      expect(sessionStore.sdkMessages.value).toHaveLength(1);
      expect(trace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subscriptionId,
          outcome: 'applied',
          addedIds: ['assistant-secret'],
          version: 3,
          renderedCount: 1,
        }),
        'messages.liveQuery'
      );

      sessionStore.activeMessagesSubscriptionId = 'replacement-subscription';
      hub.fire('liveQuery.delta', { subscriptionId, removed: [row], version: 4 });
      expect(sessionStore.sdkMessages.value).toHaveLength(1);
      expect(trace).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subscriptionId,
          activeSubscriptionId: 'replacement-subscription',
          outcome: 'superseded',
          removedIds: ['assistant-secret'],
          version: 4,
        }),
        'messages.liveQuery'
      );
      expect(JSON.stringify(trace.mock.calls)).not.toContain('private answer');
    } finally {
      trace.mockRestore();
    }
  });

  it('applies the cold-mount snapshot sorted by timestamp and opens the messagesLoaded gate', async () => {
    await sessionStore.select('session-1');
    const subId = hub.subscriptionId!;
    expect(subId).toBeTruthy();
    expect(sessionStore.messagesLoaded.value).toBe(false);

    hub.fire('liveQuery.snapshot', {
      subscriptionId: subId,
      rows: [
        { id: 'b', uuid: 'b', type: 'text', role: 'assistant', timestamp: 2 },
        { id: 'a', uuid: 'a', type: 'text', role: 'user', timestamp: 1 },
      ],
    });

    expect(sessionStore.messagesLoaded.value).toBe(true);
    expect(sessionStore.sdkMessages.value.map((m) => m.uuid)).toEqual(['a', 'b']);
  });

  it('re-subscribes with the same subscription id on WebSocket reconnect', async () => {
    await sessionStore.select('session-1');
    const subId = hub.subscriptionId!;
    expect(hub.subscribeCalls).toHaveLength(1);

    hub.fireConnection('disconnected');
    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(hub.subscribeCalls).toHaveLength(2);
    });

    const resubscribe = hub.subscribeCalls[1];
    expect(resubscribe.queryName).toBe('messages.bySession');
    expect(resubscribe.subscriptionId).toBe(subId);
    expect(resubscribe.params).toEqual(hub.subscribeCalls[0].params);
  });

  it('re-applies a fresh snapshot after reconnect, replacing stale messages', async () => {
    await sessionStore.select('session-1');
    const subId = hub.subscriptionId!;

    hub.fire('liveQuery.snapshot', {
      subscriptionId: subId,
      rows: [{ id: 'old', uuid: 'old', type: 'text', role: 'user', timestamp: 1 }],
    });
    expect(sessionStore.sdkMessages.value.map((m) => m.uuid)).toEqual(['old']);

    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(hub.subscribeCalls).toHaveLength(2);
    });
    hub.fire('liveQuery.snapshot', {
      subscriptionId: subId,
      rows: [
        { id: 'fresh-1', uuid: 'fresh-1', type: 'text', role: 'user', timestamp: 1 },
        { id: 'fresh-2', uuid: 'fresh-2', type: 'text', role: 'assistant', timestamp: 2 },
      ],
    });

    expect(sessionStore.sdkMessages.value.map((m) => m.uuid)).toEqual(['fresh-1', 'fresh-2']);
    expect(sessionStore.sdkMessages.value.some((m) => m.uuid === 'old')).toBe(false);
  });

  it('does not re-subscribe for a subscription that has been superseded by a session switch', async () => {
    await sessionStore.select('session-1');
    expect(hub.subscribeCalls).toHaveLength(1);

    hub.subscribeCalls.length = 0;
    await sessionStore.select('session-2');

    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(hub.subscribeCalls.length).toBeGreaterThanOrEqual(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const session1Resubscribes = hub.subscribeCalls.filter(
      (c) => c.params[0] === 'session-1'
    ).length;
    expect(session1Resubscribes).toBe(0);
  });

  const userRow = { id: 'row-user', uuid: 'u-user', type: 'user', timestamp: 1 };
  const assistantRow = {
    id: 'row-assistant',
    uuid: 'u-assistant',
    type: 'assistant',
    timestamp: 2,
    message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] },
  };
  const resultRow = { id: 'row-result', uuid: 'u-result', type: 'result', timestamp: 3 };

  function assistantText(): string | undefined {
    const row = sessionStore.sdkMessages.value.find((m) => m.uuid === 'u-assistant');
    return row?.message?.content?.[0]?.text;
  }

  it('resynchronizes when a delta reveals the transcript is missing a stored message', async () => {
    await sessionStore.select('session-1');
    const subId = hub.subscriptionId!;

    hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows: [userRow] });
    hub.fire('liveQuery.delta', { subscriptionId: subId, added: [resultRow], rowCount: 3 });

    expect(assistantText()).toBeUndefined();

    await vi.waitFor(() => {
      expect(hub.subscribeCalls).toHaveLength(2);
    });
    expect(hub.subscribeCalls[1].subscriptionId).toBe(subId);

    hub.fire('liveQuery.snapshot', {
      subscriptionId: subId,
      rows: [userRow, assistantRow, resultRow],
    });

    expect(assistantText()).toBe('the answer');
  });

  it('resynchronizes when deltas are being discarded because no snapshot ever arrived', async () => {
    await sessionStore.select('session-1');
    const subId = hub.subscriptionId!;

    hub.fire('liveQuery.delta', { subscriptionId: subId, added: [assistantRow], rowCount: 2 });
    expect(sessionStore.sdkMessages.value).toHaveLength(0);

    await vi.waitFor(() => {
      expect(hub.subscribeCalls).toHaveLength(2);
    });

    hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows: [userRow, assistantRow] });
    expect(assistantText()).toBe('the answer');
  });

  it('resynchronizes only once the transcript actually diverges', async () => {
    await sessionStore.select('session-1');
    const subId = hub.subscriptionId!;

    hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows: [userRow] });
    hub.fire('liveQuery.delta', { subscriptionId: subId, added: [assistantRow], rowCount: 2 });

    expect(assistantText()).toBe('the answer');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.subscribeCalls).toHaveLength(1);

    hub.fire('liveQuery.delta', { subscriptionId: subId, added: [resultRow], rowCount: 4 });
    await vi.waitFor(() => {
      expect(hub.subscribeCalls).toHaveLength(2);
    });

    hub.fire('liveQuery.delta', { subscriptionId: subId, added: [], rowCount: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.subscribeCalls).toHaveLength(2);
  });
});
