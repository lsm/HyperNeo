// @ts-nocheck
/**
 * Multi-instance SessionStore isolation.
 *
 * Regression coverage for the foundational state-ownership bug where multiple
 * mounted chats competed over one process-wide singleton: one chat would
 * display another session, clearing the base chat on overlay unmount, or
 * combine an unrelated error with an empty-state view.
 *
 * These tests prove two real `SessionStore` instances (a base chat A and an
 * overlaid chat B) fully own their selection, transcript, errors, optimistic
 * echo, and subscription lifecycle — `select()`/unmount/destroy on one never
 * touches the other, and `refreshAllSessionStores()` covers every active view.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionStore, refreshAllSessionStores } from '../session-store';

// A single controllable hub that connectionManager.getHub() resolves to. Both
// stores share it; each store's handlers self-filter LiveQuery events by
// subscriptionId, so firing an event for B's subscription can never land in A.
const multiHub = {
  request: vi.fn(),
  onEvent: vi.fn(),
  onConnection: vi.fn(),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
};

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(multiHub)),
    getHubIfConnected: vi.fn(() => multiHub),
  },
}));

vi.mock('../signals', () => ({ slashCommandsSignal: { value: [] } }));

vi.mock('../toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

interface MultiHubApi {
  fire: (channel: string, data: unknown) => void;
  fireConnection: (state: string) => void;
  subscribeCalls: Array<{ subscriptionId: string; sessionId: string }>;
  unsubscribeCalls: string[];
  setSessionState: (sessionId: string, state: Record<string, unknown>) => void;
  subIdFor: (sessionId: string) => string | undefined;
}

function installHub(): MultiHubApi {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const connectionHandlers: Array<(state: string) => void> = [];
  const subscribeCalls: MultiHubApi['subscribeCalls'] = [];
  const unsubscribeCalls: string[] = [];
  const sessionStates = new Map<string, Record<string, unknown>>();

  multiHub.onEvent.mockImplementation((channel: string, cb: (data: unknown) => void) => {
    const list = handlers.get(channel) ?? [];
    list.push(cb);
    handlers.set(channel, list);
    return () => {
      const l = handlers.get(channel);
      if (!l) return;
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    };
  });

  multiHub.onConnection.mockImplementation((cb: (state: string) => void) => {
    connectionHandlers.push(cb);
    return () => {
      const i = connectionHandlers.indexOf(cb);
      if (i >= 0) connectionHandlers.splice(i, 1);
    };
  });

  multiHub.request.mockImplementation((channel: string, params?: Record<string, unknown>) => {
    if (channel === 'state.session') {
      const sid = String(params?.sessionId ?? '');
      return Promise.resolve(
        sessionStates.get(sid) ?? {
          sessionInfo: { id: sid },
          agentState: { status: 'idle' },
          commandsData: { availableCommands: [] },
        }
      );
    }
    if (channel === 'liveQuery.subscribe') {
      const subscriptionId = String(params?.subscriptionId ?? '');
      const sessionId = String((params?.params as unknown[])?.[0] ?? '');
      subscribeCalls.push({ subscriptionId, sessionId });
      return Promise.resolve({ subscriptionId });
    }
    if (channel === 'liveQuery.unsubscribe') {
      unsubscribeCalls.push(String(params?.subscriptionId ?? ''));
      return Promise.resolve({ ok: true });
    }
    if (channel === 'message.count') return Promise.resolve({ count: 0 });
    return Promise.resolve(undefined);
  });

  multiHub.joinChannel.mockImplementation(() => {});
  multiHub.leaveChannel.mockImplementation(() => {});

  return {
    fire: (channel, data) => {
      for (const h of handlers.get(channel) ?? []) h(data);
    },
    fireConnection: (state) => {
      for (const h of connectionHandlers) h(state);
    },
    subscribeCalls,
    unsubscribeCalls,
    setSessionState: (sid, state) => sessionStates.set(sid, state),
    subIdFor: (sessionId) => {
      const found = [...subscribeCalls].reverse().find((c) => c.sessionId === sessionId);
      return found?.subscriptionId;
    },
  };
}

async function selectWithSnapshot(
  store: InstanceType<typeof SessionStore>,
  hub: MultiHubApi,
  sessionId: string,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  await store.select(sessionId);
  const subId = hub.subIdFor(sessionId);
  hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows });
}

describe('SessionStore multi-instance isolation', () => {
  let hub: MultiHubApi;
  let storeA: InstanceType<typeof SessionStore>;
  let storeB: InstanceType<typeof SessionStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    hub = installHub();
    storeA = new SessionStore();
    storeB = new SessionStore();
  });

  afterEach(async () => {
    await storeA.destroy();
    await storeB.destroy();
  });

  it('keeps each instance selection independent when mounted concurrently', async () => {
    await storeA.select('session-a');
    await storeB.select('session-b');

    expect(storeA.activeSessionId.value).toBe('session-a');
    expect(storeB.activeSessionId.value).toBe('session-b');
  });

  it('keeps transcripts independent — B never renders A messages', async () => {
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    expect(storeA.sdkMessages.value.map((m) => m.uuid)).toEqual(['a1']);
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);
  });

  it('drops a late snapshot whose subscriptionId belongs to another instance', async () => {
    // A mounts, loads; B mounts later. A snapshot fired for B's subscription
    // must NOT be applied to A (the cross-instance contamination bug).
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    await storeB.select('session-b');
    const bSub = hub.subIdFor('session-b');

    hub.fire('liveQuery.snapshot', {
      subscriptionId: bSub,
      rows: [{ id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 }],
    });

    expect(storeA.sdkMessages.value.map((m) => m.uuid)).toEqual(['a1']);
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);
  });

  it('keeps errors independent — A error never combines with B view', async () => {
    hub.setSessionState('session-a', {
      sessionInfo: { id: 'session-a' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      error: { message: 'A failed', occurredAt: Date.now() },
    });

    await storeA.select('session-a');
    await storeB.select('session-b');

    expect(storeA.error.value?.message).toBe('A failed');
    expect(storeB.error.value).toBeNull();
  });

  it('unmounting B (select null) leaves A untouched', async () => {
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    await storeB.select(null);

    // B is cleared and deselected …
    expect(storeB.activeSessionId.value).toBeNull();
    expect(storeB.sdkMessages.value).toEqual([]);
    // … but A is fully intact — no global deselect/clear leaked across.
    expect(storeA.activeSessionId.value).toBe('session-a');
    expect(storeA.sdkMessages.value.map((m) => m.uuid)).toEqual(['a1']);
  });

  it('destroying B leaves A intact and drops B from the reconnect registry', async () => {
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    const refreshA = vi.spyOn(storeA, 'refresh').mockResolvedValue(undefined);
    const refreshB = vi.spyOn(storeB, 'refresh').mockResolvedValue(undefined);

    await refreshAllSessionStores();
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).toHaveBeenCalledTimes(1);

    await storeB.destroy();
    refreshA.mockClear();
    refreshB.mockClear();

    await refreshAllSessionStores();
    // A is still registered and refreshed; B is gone.
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).not.toHaveBeenCalled();

    // A's state is unchanged by B's destruction.
    expect(storeA.activeSessionId.value).toBe('session-a');
    expect(storeA.sdkMessages.value.map((m) => m.uuid)).toEqual(['a1']);
    expect(storeB.activeSessionId.value).toBeNull();
  });

  it('rapid B→C switch ends on C with no leftover B subscription', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    const bSub = hub.subIdFor('session-b');

    // Switch the same instance to a different session (overlay remount B→C).
    await selectWithSnapshot(storeB, hub, 'session-c', [
      { id: 'c1', uuid: 'c1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    expect(storeB.activeSessionId.value).toBe('session-c');
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['c1']);
    // The previous subscription was released server-side.
    expect(hub.unsubscribeCalls).toContain(bSub);
  });

  it('keeps optimistic (prepended) messages isolated per instance', async () => {
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    storeA.prependMessages([
      { id: 'a0', uuid: 'a0', type: 'text', role: 'user', timestamp: 0 } as never,
    ]);

    expect(storeA.sdkMessages.value.map((m) => m.uuid)).toEqual(['a0', 'a1']);
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);
  });

  it('self-refreshes session state on transport reconnect', async () => {
    hub.setSessionState('session-b', {
      sessionInfo: { id: 'session-b', title: 'refreshed' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
    });

    await storeB.select('session-b');
    expect(storeB.sessionInfo.value?.title).toBe('refreshed');

    // Transport reconnect must drive a fresh state.session fetch per instance.
    const stateRequestsBefore = multiHub.request.mock.calls.filter(
      (c) => c[0] === 'state.session'
    ).length;
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    await vi.waitFor(() => {
      const stateRequestsAfter = multiHub.request.mock.calls.filter(
        (c) => c[0] === 'state.session'
      ).length;
      expect(stateRequestsAfter).toBeGreaterThan(stateRequestsBefore);
    });
  });
});
