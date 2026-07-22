// @ts-nocheck
/**
 * Chat/Thread Lifecycle Recovery — SessionStore cold mount + reconnect.
 *
 * Regression coverage for scenarios 1 (cold mount) and 4 (WebSocket
 * reconnect). The comprehensive suite covers the snapshot/delta apply and
 * the messagesLoaded gate; this file adds the missing recovery invariant:
 * on reconnect, the store re-subscribes to `messages.bySession` with the
 * SAME subscription id and a fresh snapshot re-applies, so a transient
 * socket drop never leaves the thread frozen on stale or empty content.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../session-store';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

// A single module-level hub that connectionManager.getHub() resolves to.
// installLifecycleHub() re-binds its handlers with fresh state per test.
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

  it('applies the cold-mount snapshot sorted by timestamp and opens the messagesLoaded gate', async () => {
    await sessionStore.select('session-1');
    const subId = hub.subscriptionId!;
    expect(subId).toBeTruthy();
    expect(sessionStore.messagesLoaded.value).toBe(false);

    // Snapshot delivered out of timestamp order — the store must sort.
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

    // Simulate a transient socket drop and recovery.
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');
    // The reconnect handler re-issues liveQuery.subscribe asynchronously.
    await vi.waitFor(() => {
      expect(hub.subscribeCalls).toHaveLength(2);
    });

    const resubscribe = hub.subscribeCalls[1];
    expect(resubscribe.queryName).toBe('messages.bySession');
    expect(resubscribe.subscriptionId).toBe(subId);
  });

  it('re-applies a fresh snapshot after reconnect, replacing stale messages', async () => {
    await sessionStore.select('session-1');
    const subId = hub.subscriptionId!;

    hub.fire('liveQuery.snapshot', {
      subscriptionId: subId,
      rows: [{ id: 'old', uuid: 'old', type: 'text', role: 'user', timestamp: 1 }],
    });
    expect(sessionStore.sdkMessages.value.map((m) => m.uuid)).toEqual(['old']);

    // Reconnect pushes a brand-new snapshot; the store replaces wholesale.
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

    // Switch away — the active subscription id is replaced and the reconnect
    // handler for the prior subscription must short-circuit.
    hub.subscribeCalls.length = 0;
    await sessionStore.select('session-2');

    hub.fireConnection('connected');
    // The session-2 subscribe fires (new subscription id), but the superseded
    // session-1 reconnect handler must NOT add an extra re-subscribe for it.
    await vi.waitFor(() => {
      expect(hub.subscribeCalls.length).toBeGreaterThanOrEqual(1);
    });
    // Give any stray async re-subscribe a chance, then assert no further calls.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const session1Resubscribes = hub.subscribeCalls.filter(
      (c) => c.params[0] === 'session-1'
    ).length;
    expect(session1Resubscribes).toBe(0);
  });
});
