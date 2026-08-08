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

// Test knob: when set, connectionManager.getHub() returns this pending promise
// instead of resolving immediately, so refresh() can be caught mid-await.
const getHubCtrl = vi.hoisted(() => ({ deferred: null as Promise<unknown> | null }));

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => getHubCtrl.deferred ?? Promise.resolve(multiHub)),
    getHubIfConnected: vi.fn(() => multiHub),
  },
}));

vi.mock('../signals', () => ({ slashCommandsSignal: { value: [] } }));

vi.mock('../toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

interface MultiHubApi {
  fire: (channel: string, data: unknown) => void;
  /**
   * Fire a channel-scoped EVENT (state.session / context.updated) the way the
   * real MessageHub dispatches it: every handler registered for `method` is
   * invoked with `(data, { channel })`. The store's per-instance handler must
   * filter on context.channel so an event for session A never lands in store B.
   */
  fireChannelEvent: (method: string, data: unknown, channel: string) => void;
  fireConnection: (state: string) => void;
  subscribeCalls: Array<{ subscriptionId: string; sessionId: string }>;
  unsubscribeCalls: string[];
  setSessionState: (sessionId: string, state: Record<string, unknown>) => void;
  setStateSessionDeferred: (promise: Promise<unknown> | null) => void;
  setStateSessionError: (error: unknown) => void;
  /**
   * Queue distinct `state.session` RPC responses. Each request shifts the next
   * queued promise, letting two concurrent fetches for the same session resolve
   * with different data in a controlled order (the per-fetch versioning test).
   */
  queueStateSession: (promise: Promise<unknown>) => void;
  /**
   * Make `joinChannel` return a controllable promise so a test can hold a join
   * mid-backoff (simulating MessageHub's retry loop) and resolve it later.
   */
  setJoinChannelDeferred: (promise: Promise<unknown> | null) => void;
  subIdFor: (sessionId: string) => string | undefined;
}

function installHub(): MultiHubApi {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const connectionHandlers: Array<(state: string) => void> = [];
  const subscribeCalls: MultiHubApi['subscribeCalls'] = [];
  const unsubscribeCalls: string[] = [];
  const sessionStates = new Map<string, Record<string, unknown>>();
  let stateSessionDeferred: Promise<unknown> | null = null;
  let stateSessionError: unknown = null;
  // FIFO of hand-crafted state.session responses; each request shifts one.
  const stateSessionQueue: Array<Promise<unknown>> = [];
  // When set, joinChannel returns this promise (simulating a retrying join).
  let joinChannelDeferred: Promise<unknown> | null = null;

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
      // A queued response (per-request control) takes precedence over the
      // global deferred/error knobs.
      if (stateSessionQueue.length) return stateSessionQueue.shift()!;
      // Test knobs: inject a controllable deferred or a forced error to drive
      // the reconnect race / retain-on-error scenarios.
      if (stateSessionError) return Promise.reject(stateSessionError);
      if (stateSessionDeferred) return stateSessionDeferred;
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

  multiHub.joinChannel.mockImplementation(() => joinChannelDeferred ?? undefined);
  multiHub.leaveChannel.mockImplementation(() => {});

  return {
    fire: (channel, data) => {
      for (const h of handlers.get(channel) ?? []) h(data);
    },
    fireChannelEvent: (method, data, channel) => {
      for (const h of handlers.get(method) ?? []) h(data, { channel });
    },
    fireConnection: (state) => {
      for (const h of connectionHandlers) h(state);
    },
    subscribeCalls,
    unsubscribeCalls,
    setSessionState: (sid, state) => sessionStates.set(sid, state),
    setStateSessionDeferred: (p) => {
      stateSessionDeferred = p;
    },
    setStateSessionError: (e) => {
      stateSessionError = e;
    },
    queueStateSession: (p) => {
      stateSessionQueue.push(p);
    },
    setJoinChannelDeferred: (p) => {
      joinChannelDeferred = p;
    },
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
    getHubCtrl.deferred = null;
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

  it('leaves its session channel on destroy even if it runs before a queued select(null)', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    multiHub.leaveChannel.mockClear();

    // destroy() must release session:b itself — a parent unmount can run it
    // before the child's queued select(null) resolves, and that deselection
    // keys leaveChannel off activeSessionId, so clearing first would skip the
    // leave and leak the channel membership until reconnect.
    await storeB.destroy();
    expect(multiHub.leaveChannel).toHaveBeenCalledWith('session:session-b');
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

  it('does not cross-apply a state.session EVENT fired on another session channel', async () => {
    await storeA.select('session-a');
    await storeB.select('session-b');
    expect(storeB.agentState.value.status).toBe('idle');

    // The daemon dispatches a state.session event to EVERY handler registered
    // for the method (the connection joined both session channels). storeB's
    // handler must filter it out by channel so session-a never overwrites it.
    hub.fireChannelEvent(
      'state.session',
      {
        sessionInfo: { id: 'session-a', title: 'A-updated' },
        agentState: { status: 'processing' },
        commandsData: { availableCommands: ['/a-only'] },
        error: null,
      },
      'session:session-a'
    );

    // storeA applies the event; storeB is untouched.
    expect(storeA.agentState.value.status).toBe('processing');
    expect(storeA.sessionInfo.value?.title).toBe('A-updated');
    expect(storeB.agentState.value.status).toBe('idle');
    expect(storeB.sessionInfo.value?.id).toBe('session-b');
  });

  it('does not cross-apply a context.updated EVENT fired on another session channel', async () => {
    await storeA.select('session-a');
    await storeB.select('session-b');
    const ctx = { inputTokens: 1234, outputTokens: 56 } as never;
    hub.fireChannelEvent('context.updated', ctx, 'session:session-a');

    expect(storeA.contextInfo.value).toEqual(ctx);
    // storeB never joined session-a's channel — its context stays unset.
    expect(storeB.contextInfo.value).toBeNull();
  });

  it('preserves last valid state when a refresh-time state.session RPC fails', async () => {
    hub.setSessionState('session-b', {
      sessionInfo: { id: 'session-b', title: 'good' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
    });
    await storeB.select('session-b');
    expect(storeB.sessionInfo.value?.title).toBe('good');

    // A transient RPC failure during reconnect/refresh must NOT clobber the
    // restored state with a fatal load error (which would flip ChatContainer
    // to the load screen despite a valid transcript).
    hub.setStateSessionError(new Error('transient blip'));
    await storeB.refresh();

    expect(storeB.sessionInfo.value?.title).toBe('good');
    expect(storeB.error.value).toBeNull();
  });

  it('discards a reconnect refresh response that lands after a session switch', async () => {
    await storeB.select('session-b');

    // Hold the reconnect-driven state.session RPC pending so we can switch
    // sessions before it resolves.
    let resolveB: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveB = res;
      })
    );

    // Transport reconnect while session-b is active starts a refresh for
    // session-b whose RPC is pending on resolveB.
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    // Switch to session-c before session-b's refresh resolves. Clear the
    // deferred so session-c's own RPC resolves normally.
    hub.setStateSessionDeferred(null);
    await storeB.select('session-c');
    expect(storeB.sessionInfo.value?.id).toBe('session-c');

    // Now resolve the stale session-b refresh. The switch-guard must discard
    // it so session-c is not overwritten.
    resolveB({
      sessionInfo: { id: 'session-b', title: 'stale' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(storeB.sessionInfo.value?.id).toBe('session-c');
  });

  it('tears down an in-flight select on destroy and refuses to resurrect', async () => {
    // Hold the state.session RPC so startSubscriptions is mid-await when destroy runs.
    let resolveState: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveState = res;
      })
    );
    const selectP = storeB.select('session-b');
    // Let doSelect reach startSubscriptions (awaiting the deferred RPC).
    await new Promise((r) => setTimeout(r, 10));

    // destroy() chains through selectPromise: the in-flight startSubscriptions
    // completes first, then teardown reaps its handlers. A later select must
    // not resurrect the destroyed store.
    const destroyP = storeB.destroy();
    resolveState({
      sessionInfo: { id: 'session-b' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await Promise.all([selectP, destroyP]);
    await new Promise((r) => setTimeout(r, 10));

    expect(storeB.activeSessionId.value).toBeNull();
    await storeB.select('session-c');
    expect(storeB.activeSessionId.value).toBeNull();
    expect(hub.subscribeCalls.some((c) => c.sessionId === 'session-c')).toBe(false);
  });

  it('does not leave a session channel another live store still holds', async () => {
    // Base and overlay both select the same session — they share one channel
    // membership. Destroying one must not evict the other.
    await selectWithSnapshot(storeA, hub, 'shared', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    await selectWithSnapshot(storeB, hub, 'shared', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    multiHub.leaveChannel.mockClear();

    await storeB.destroy();

    expect(multiHub.leaveChannel).not.toHaveBeenCalledWith('session:shared');
    expect(storeA.activeSessionId.value).toBe('shared');
  });

  it('rejoins the session channel on transport reconnect', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    multiHub.joinChannel.mockClear();

    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    await vi.waitFor(() => {
      expect(multiHub.joinChannel).toHaveBeenCalledWith('session:session-b');
    });
  });

  it('rejoins the session channel on refresh (soft-resume path)', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    multiHub.joinChannel.mockClear();

    await storeB.refresh();

    expect(multiHub.joinChannel).toHaveBeenCalledWith('session:session-b');
  });

  it('generates unique subscription ids for the same session in the same millisecond', async () => {
    // Force Date.now() constant so two same-session subscribes would collide
    // without an instance/global disambiguator.
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(12345);
    try {
      await storeA.select('shared');
      await storeB.select('shared');
    } finally {
      dateSpy.mockRestore();
    }

    const ids = hub.subscribeCalls
      .filter((c) => c.sessionId === 'shared')
      .map((c) => c.subscriptionId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('does not rejoin a session switched away from during refresh (selection epoch)', async () => {
    await selectWithSnapshot(storeB, hub, 'session-x', [
      { id: 'x1', uuid: 'x1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    // Hold refresh() mid-await on getHub, then clear the knob so the Y
    // selection's own getHub (inside startSubscriptions) resolves normally.
    let resolveHub: (value: unknown) => void = () => {};
    getHubCtrl.deferred = new Promise((res) => {
      resolveHub = res;
    });
    const refreshP = storeB.refresh();
    getHubCtrl.deferred = null;
    await storeB.select('session-y');
    multiHub.joinChannel.mockClear();
    resolveHub(multiHub);
    await refreshP;

    // refresh captured epoch for X; the Y selection bumped it, so refresh must
    // NOT rejoin session-x.
    expect(multiHub.joinChannel).not.toHaveBeenCalledWith('session:session-x');
  });

  it('discards a stale same-session refresh response after a reselect (epoch)', async () => {
    // Load X into an error state so a Retry (same-id reselect) runs doSelect.
    hub.setSessionState('session-x', {
      sessionInfo: { id: 'session-x' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      error: { message: 'boom', occurredAt: 1 },
    });
    await storeB.select('session-x');
    expect(storeB.error.value?.message).toBe('boom');

    // A reconnect refresh for X starts and its state.session RPC stays pending.
    let resolveReconnect: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveReconnect = res;
      })
    );
    hub.fireConnection('connected');

    // Retry: reselect the SAME session. doSelect runs (alreadyLoaded is false on
    // error), bumps the epoch, and loads good state.
    hub.setStateSessionDeferred(null);
    hub.setSessionState('session-x', {
      sessionInfo: { id: 'session-x', title: 'recovered' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await storeB.select('session-x');
    expect(storeB.sessionInfo.value?.title).toBe('recovered');

    // The stale reconnect response resolves last. Without the epoch guard it
    // would pass the activeSessionId check (still session-x) and overwrite.
    resolveReconnect({
      sessionInfo: { id: 'session-x', title: 'STALE' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(storeB.sessionInfo.value?.title).toBe('recovered');
  });

  it('commits only the freshest-issued concurrent state.session fetch (per-fetch versioning)', async () => {
    await storeB.select('session-b');

    // Two overlapping refresh RPCs for the SAME session (same selectGeneration,
    // no intervening select). Issue the OLDER fetch first, then resolve the
    // NEWER one first and the OLDER one last. selectGeneration alone can't tell
    // these apart, so without per-fetch versioning the older snapshot resolves
    // last and overwrites the fresher commit.
    let resolveOlder: (value: unknown) => void = () => {};
    let resolveNewer: (value: unknown) => void = () => {};
    hub.queueStateSession(
      new Promise((res) => {
        resolveOlder = res;
      })
    );
    hub.queueStateSession(
      new Promise((res) => {
        resolveNewer = res;
      })
    );

    const r1 = storeB.refresh();
    const r2 = storeB.refresh();

    resolveNewer({
      sessionInfo: { id: 'session-b', title: 'NEW' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(storeB.sessionInfo.value?.title).toBe('NEW');
    expect(storeB.agentState.value.status).toBe('processing');

    // The older fetch resolves LAST — it must NOT overwrite the fresher commit.
    resolveOlder({
      sessionInfo: { id: 'session-b', title: 'STALE' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await Promise.all([r1, r2]);

    expect(storeB.sessionInfo.value?.title).toBe('NEW');
    expect(storeB.agentState.value.status).toBe('processing');
  });

  it('does not let a failed retainOnError refresh block a concurrent fetch (no slot claim)', async () => {
    await storeB.select('session-b');

    // A good fetch (older ticket) stays pending while a LATER retainOnError
    // refresh fails. The failure must NOT advance the commit slot, so the good
    // fetch still commits when it resolves — guarding against a naive
    // entry-bumped "last started wins" counter, which would discard it.
    let resolveGood: (value: unknown) => void = () => {};
    hub.queueStateSession(
      new Promise((res) => {
        resolveGood = res;
      })
    );
    hub.queueStateSession(Promise.reject(new Error('transient blip')));

    const rGood = storeB.refresh(); // shifts the good (pending) response
    const rFail = storeB.refresh(); // shifts the rejecting response
    // Let the failing retainOnError fetch settle (it returns early, committing
    // nothing). rGood stays pending on `good`.
    await new Promise((r) => setTimeout(r, 10));

    resolveGood({
      sessionInfo: { id: 'session-b', title: 'recovered' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
    });
    await Promise.allSettled([rGood, rFail]);

    expect(storeB.sessionInfo.value?.title).toBe('recovered');
    // retainOnError preserved existing state — no fatal load error surfaced.
    expect(storeB.error.value).toBeNull();
  });

  it('releases a session channel whose retrying join succeeded after a switch', async () => {
    await selectWithSnapshot(storeB, hub, 'session-x', [
      { id: 'x1', uuid: 'x1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    // Hold refresh()'s joinChannel pending to simulate MessageHub's retry loop
    // mid-backoff, and hold its state.session RPC so refresh stays in flight.
    let resolveJoin: () => void = () => {};
    let resolveState: (value: unknown) => void = () => {};
    hub.setJoinChannelDeferred(
      new Promise((res) => {
        resolveJoin = res;
      })
    );
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveState = res;
      })
    );
    const refreshP = storeB.refresh();
    // Let refresh() reach its joinChannel call + state await.
    await new Promise((r) => setTimeout(r, 10));

    // Switch to Y (clear knobs first so Y's own join/state resolve normally).
    hub.setJoinChannelDeferred(null);
    hub.setStateSessionDeferred(null);
    await storeB.select('session-y');

    const leavesXBefore = multiHub.leaveChannel.mock.calls.filter(
      (c) => c[0] === 'session:session-x'
    ).length;
    // doSelect released session-x during the switch.
    expect(leavesXBefore).toBeGreaterThanOrEqual(1);

    // The retrying X join now succeeds (rejoins X). Without the release-on-
    // settle guard this stray membership leaks until the next reconnect; with
    // it, refresh releases session-x.
    resolveJoin();
    resolveState();
    await refreshP;
    await new Promise((r) => setTimeout(r, 10));

    const leavesXAfter = multiHub.leaveChannel.mock.calls.filter(
      (c) => c[0] === 'session:session-x'
    ).length;
    expect(leavesXAfter).toBeGreaterThan(leavesXBefore);
  });
});
