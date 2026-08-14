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
import {
  SessionStore,
  refreshAllSessionStores,
  mergeSnapshotIntoTranscript,
  markAllSessionStoresRecovering,
  applyOptimisticSessionInfo,
} from '../session-store';

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
  /** Force liveQuery.subscribe to reject (null clears it). */
  setLiveQuerySubscribeError: (error: unknown) => void;
  /** Force channel.join to reject (null clears it). */
  setChannelJoinError: (error: unknown) => void;
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
  // When set, liveQuery.subscribe rejects (simulating a failed re-subscribe
  // during recovery, so the "stay recovering" path can be exercised).
  let liveQuerySubscribeError: unknown = null;
  // When set, channel.join rejects (simulating a session-channel rejoin that
  // never settles successfully during recovery).
  let channelJoinError: unknown = null;

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
      if (liveQuerySubscribeError) return Promise.reject(liveQuerySubscribeError);
      return Promise.resolve({ subscriptionId });
    }
    if (channel === 'liveQuery.unsubscribe') {
      unsubscribeCalls.push(String(params?.subscriptionId ?? ''));
      return Promise.resolve({ ok: true });
    }
    if (channel === 'message.count') return Promise.resolve({ count: 0 });
    if (channel === 'channel.join') {
      if (channelJoinError) return Promise.reject(channelJoinError);
      return Promise.resolve({ ok: true });
    }
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
    setLiveQuerySubscribeError: (e) => {
      liveQuerySubscribeError = e;
    },
    setChannelJoinError: (e) => {
      channelJoinError = e;
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

  it('applyOptimisticSessionInfo patches only stores where the session is active', async () => {
    await storeA.select('session-a');
    await storeB.select('session-b');

    applyOptimisticSessionInfo('session-a', { title: 'Renamed A' });

    // The store rendering session-a sees the optimistic title immediately…
    expect(storeA.sessionInfo.value?.title).toBe('Renamed A');
    // …and a different session's store is untouched, as is an inactive one.
    expect(storeB.sessionInfo.value?.title).toBeUndefined();

    // Non-active session ids (e.g. sidebar-only rows) are a no-op everywhere.
    applyOptimisticSessionInfo('session-idle', { title: 'Ignored' });
    expect(storeA.sessionInfo.value?.title).toBe('Renamed A');
  });

  it('applyOptimisticSessionInfo rollback guard preserves newer titles', async () => {
    await storeA.select('session-a');

    applyOptimisticSessionInfo('session-a', { title: 'Optimistic' });
    expect(storeA.sessionInfo.value?.title).toBe('Optimistic');

    // Matching expected title: the rollback applies.
    applyOptimisticSessionInfo('session-a', { title: 'Old Title' }, 'Optimistic');
    expect(storeA.sessionInfo.value?.title).toBe('Old Title');

    // Mismatched expected title (a newer title landed while the request was
    // pending): the rollback is skipped so the newer title survives.
    applyOptimisticSessionInfo('session-a', { title: 'Stale Rollback' }, 'Optimistic');
    expect(storeA.sessionInfo.value?.title).toBe('Old Title');
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

    const refreshA = vi.spyOn(storeA, 'recover').mockResolvedValue(undefined);
    const refreshB = vi.spyOn(storeB, 'recover').mockResolvedValue(undefined);

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
    multiHub.request.mockClear();

    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    // Recovery re-issues channel.join via hub.request (so it can retry and gate
    // readiness on a settled join), not the fire-and-forget joinChannel.
    await vi.waitFor(() => {
      expect(multiHub.request).toHaveBeenCalledWith(
        'channel.join',
        { channel: 'session:session-b' },
        expect.anything()
      );
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

  it('does not let a reconnect-refresh RPC overwrite a newer state.session push (revision)', async () => {
    await selectWithSnapshot(storeB, hub, 'session-x', [
      { id: 'x1', uuid: 'x1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.agentState.value.status).toBe('idle');

    // Hold the reconnect-refresh RPC in flight. It resolves with an OLDER
    // capture (revision 2) than the push below (revision 3) — the daemon
    // captures the RPC snapshot before an async gap, so a push generated during
    // that gap can be newer yet arrive around the RPC response.
    let resolveRpc: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveRpc = res;
      })
    );
    const refreshP = storeB.refresh();
    await new Promise((r) => setTimeout(r, 10)); // let refresh reach the RPC await

    // A FULL state.session push lands while the RPC is in flight, with a HIGHER
    // (newer) capture-order revision.
    hub.fireChannelEvent(
      'state.session',
      {
        sessionInfo: { id: 'session-x' },
        agentState: { status: 'processing' },
        commandsData: { availableCommands: [] },
        error: null,
        revision: 3,
      },
      'session:session-x'
    );
    expect(storeB.agentState.value.status).toBe('processing');

    // The RPC resolves with the OLDER snapshot (revision 2). It must NOT revert.
    resolveRpc({
      sessionInfo: { id: 'session-x' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 2,
    });
    hub.setStateSessionDeferred(null);
    await refreshP;
    await new Promise((r) => setTimeout(r, 10));

    expect(storeB.agentState.value.status).toBe('processing');
  });

  it('does not let an older state.session push revert a newer reconnect-refresh RPC (inverse race)', async () => {
    // P2-H: the inverse of the race above. An OLDER broadcast (captured earlier,
    // stalled in the daemon's getSlashCommands await) sends its push during the
    // RPC window with a LOWER revision. An arrival-counter cannot distinguish
    // this from the newer-push case and would discard the fresher RPC; only the
    // server-stamped capture-order revision resolves it correctly.
    await selectWithSnapshot(storeB, hub, 'session-x', [
      { id: 'x1', uuid: 'x1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    let resolveRpc: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveRpc = res;
      })
    );
    const refreshP = storeB.refresh();
    await new Promise((r) => setTimeout(r, 10));

    // The OLDER push (revision 2, stale idle) lands during the RPC window. It
    // applies briefly (2 > 0)…
    hub.fireChannelEvent(
      'state.session',
      {
        sessionInfo: { id: 'session-x' },
        agentState: { status: 'idle' },
        commandsData: { availableCommands: [] },
        error: null,
        revision: 2,
      },
      'session:session-x'
    );
    expect(storeB.agentState.value.status).toBe('idle');

    // …then the NEWER RPC (revision 3, fresh processing) resolves and wins.
    resolveRpc({
      sessionInfo: { id: 'session-x' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
      revision: 3,
    });
    hub.setStateSessionDeferred(null);
    await refreshP;
    await new Promise((r) => setTimeout(r, 10));

    expect(storeB.agentState.value.status).toBe('processing');
  });

  it('accepts a post-restart snapshot whose revision is below the stale watermark (daemon epoch)', async () => {
    // P1 regression: the server revision counter is in-memory, so a daemon
    // restart resets it to 1. Without an epoch, lastAppliedRevision (e.g. 50)
    // would discard every post-restart snapshot (revision 1..50) and freeze.
    hub.setSessionState('session-x', {
      sessionInfo: { id: 'session-x', title: 'pre-restart' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 50,
      daemonEpoch: 'daemon-a',
    });
    await storeB.select('session-x');
    expect(storeB.sessionInfo.value?.title).toBe('pre-restart');

    // Daemon restarts: fresh counter (revision 1) under a new boot epoch.
    hub.setSessionState('session-x', {
      sessionInfo: { id: 'session-x', title: 'post-restart' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
      revision: 1,
      daemonEpoch: 'daemon-b',
    });
    await storeB.refresh();

    // The epoch change reset the revision gate, so the low revision applies.
    expect(storeB.sessionInfo.value?.title).toBe('post-restart');
    expect(storeB.agentState.value.status).toBe('processing');
  });

  it('a partial context.updated push guards only contextInfo, not the full-state fetch', async () => {
    // Initial load: hold the state.session RPC in flight so sessionState is
    // still null when a PARTIAL context.updated push lands mid-fetch.
    let resolveRpc: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveRpc = res;
      })
    );
    const selectP = storeB.select('session-x');
    await new Promise((r) => setTimeout(r, 10)); // let select reach the RPC await

    // A partial context.updated push lands during the fetch with newer context
    // than the fetch's pre-await snapshot will carry.
    hub.fireChannelEvent(
      'context.updated',
      { inputTokens: 999, outputTokens: 1 },
      'session:session-x'
    );
    expect(storeB.contextInfo.value).toEqual({ inputTokens: 999, outputTokens: 1 });

    // The RPC resolves with a full snapshot whose embedded lastContextInfo is
    // STALER than the push.
    resolveRpc({
      sessionInfo: {
        id: 'session-x',
        title: 'loaded',
        metadata: { lastContextInfo: { inputTokens: 111, outputTokens: 0 } },
      },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    hub.setStateSessionDeferred(null);
    await selectP;
    await new Promise((r) => setTimeout(r, 10));

    // The full-state fetch STILL committed (a partial push must not nuke it)…
    expect(storeB.sessionInfo.value?.title).toBe('loaded');
    // …but its staler contextInfo write was skipped — the push's value wins.
    expect(storeB.contextInfo.value).toEqual({ inputTokens: 999, outputTokens: 1 });
  });

  // =========================================================================
  // Session-scoped reconnect recovery (#872). Builds on the multi-instance
  // isolation above: each chat recovers its OWN session independently, the
  // `isRecovering` flag distinguishes recovery from initial-load/failure, and
  // stale async results (late errors, duplicate events) can't strand it.
  // =========================================================================

  it('is not recovering once a session is loaded normally', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('markAllSessionStoresRecovering flags active stores synchronously (resume window)', async () => {
    // Soft-resume marks every active store recovering the instant a tab
    // foregrounds, BEFORE the ≤3s health check + joins, so the composer can't
    // be used on a possibly-stale connection. performRecovery later supersedes
    // the early mark and clears it on success.
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeA.isRecovering.value).toBe(false);
    expect(storeB.isRecovering.value).toBe(false);

    markAllSessionStoresRecovering();
    expect(storeA.isRecovering.value).toBe(true);
    expect(storeB.isRecovering.value).toBe(true);

    // The later recovery supersedes the early mark and clears on success.
    await refreshAllSessionStores();
    expect(storeA.isRecovering.value).toBe(false);
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('flips isRecovering on transport drop and clears it once recovery settles', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.isRecovering.value).toBe(false);

    // Socket drops while the session is active → recovering immediately, before
    // the socket reports connected again (so the UI can keep the transcript
    // read-only throughout).
    hub.fireConnection('disconnected');
    expect(storeB.isRecovering.value).toBe(true);

    // Reconnect drives performRecovery (rejoin + resubscribe + state refresh).
    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(storeB.isRecovering.value).toBe(false);
    });
  });

  it('clears isRecovering when reconnects are permanently exhausted (failed)', async () => {
    // WebSocketClientTransport emits 'failed' after maxReconnectAttempts. The
    // earlier 'reconnecting' set isRecovering; 'failed' must clear it so the
    // "Reconnecting…" banner does not outlive the (abandoned) reconnect cycle —
    // the global ConnectionStatus reports the permanent failure instead.
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    hub.fireConnection('reconnecting');
    expect(storeB.isRecovering.value).toBe(true);

    hub.fireConnection('failed');
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('does not strand isRecovering on duplicate reconnect events', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    // Two 'connected' events with no clean ordering (a transport that emits
    // ready twice, or a manual reconnect racing the auto-reconnect). The token
    // guard must ensure only the freshest recovery clears the flag and a stale
    // one settling later can't resurrect or strand it.
    hub.fireConnection('connected');
    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(storeB.isRecovering.value).toBe(false);
    });
  });

  it('soft-resume (refreshAllSessionStores) re-establishes the messages LiveQuery', async () => {
    // Safari pauses the socket without dropping it: no transport
    // onConnection('connected') fires, so the per-instance reconnect handler
    // never runs. The resume path (refreshAllSessionStores → recover) must
    // re-subscribe messages so deltas missed while paused are re-synced via a
    // fresh snapshot — not just refresh session state.
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    const subscribesBefore = multiHub.request.mock.calls.filter(
      (c) => c[0] === 'liveQuery.subscribe'
    ).length;

    await refreshAllSessionStores();

    const subscribesAfter = multiHub.request.mock.calls.filter(
      (c) => c[0] === 'liveQuery.subscribe'
    ).length;
    expect(subscribesAfter).toBeGreaterThan(subscribesBefore);
    // The re-subscribe targets THIS session's messages query, not a stray one.
    const resubscribe = multiHub.request.mock.calls
      .filter((c) => c[0] === 'liveQuery.subscribe')
      .slice(-1)[0];
    expect(resubscribe?.[1]).toMatchObject({
      queryName: 'messages.bySession',
      params: ['session-b', expect.any(Number)],
    });
    // Soft-resume is a recovery: the flag must clear once it settles.
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('soft-resume preserves the transcript when the state RPC fails and stays recovering', async () => {
    hub.setSessionState('session-b', {
      sessionInfo: { id: 'session-b', title: 'good' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
    });
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.sessionInfo.value?.title).toBe('good');

    // A transient state-RPC failure during resume must NOT clobber the restored
    // state with a fatal load error. Recovery also can't report ready on stale
    // state — isRecovering stays true (composer disabled) until a later
    // reconnect/resume re-fetches state successfully.
    hub.setStateSessionError(new Error('transient blip'));
    await refreshAllSessionStores();
    expect(storeB.sessionInfo.value?.title).toBe('good');
    expect(storeB.error.value).toBeNull();
    expect(storeB.isRecovering.value).toBe(true);

    // Once the state RPC succeeds again (next resume/reconnect), recovery clears.
    hub.setStateSessionError(null);
    await refreshAllSessionStores();
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('clears isRecovering when a newer state push supersedes the recovery fetch', async () => {
    // If a newer state.session push lands while the recovery state RPC is in
    // flight, the push refreshes the state (advances lastAppliedRevision) and
    // supersedes the RPC. That counts as a successful refresh — recovery must
    // NOT leave isRecovering set indefinitely on a stale-ready gap.
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    let resolveRpc: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveRpc = res;
      })
    );
    multiHub.request.mockClear();
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    // Wait for recovery to reach the state fetch (channel.join + LiveQuery
    // subscribe are the Promise.all that precedes it), then yield so the state
    // RPC is awaiting the deferred before we fire the push / resolve.
    await vi.waitFor(() => {
      expect(multiHub.request).toHaveBeenCalledWith(
        'channel.join',
        expect.anything(),
        expect.anything()
      );
      expect(multiHub.request).toHaveBeenCalledWith('liveQuery.subscribe', expect.anything());
    });
    await new Promise((r) => setTimeout(r, 0));

    // A newer full-state push lands while the RPC is pending.
    hub.fireChannelEvent(
      'state.session',
      {
        sessionInfo: { id: 'session-b', title: 'pushed' },
        agentState: { status: 'processing' },
        commandsData: { availableCommands: [] },
        revision: 5,
      },
      'session:session-b'
    );
    expect(storeB.agentState.value.status).toBe('processing');

    // The (older) RPC now resolves with revision 4 — superseded by the push.
    resolveRpc({
      sessionInfo: { id: 'session-b', title: 'stale-rpc' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 4,
    });
    await new Promise((r) => setTimeout(r, 30));

    // State was refreshed (via the push) → isRecovering cleared; push value wins.
    expect(storeB.isRecovering.value).toBe(false);
    expect(storeB.sessionInfo.value?.title).toBe('pushed');
    expect(storeB.agentState.value.status).toBe('processing');
  });

  it('clears isRecovering when an overlapping refresh supersedes the recovery fetch', async () => {
    // P2a: a send accepted just before a drop arms ChatContainer's 1200ms
    // send-visibility timer, which calls store.refresh() — a newer same-session
    // fetch that can commit while the recovery fetch is still in flight. The
    // recovery fetch is then superseded by ticket; that must count as a
    // successful refresh (the newer fetch wrote fresh state), not leave
    // isRecovering stuck.
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    let resolveRpc: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveRpc = res;
      })
    );
    multiHub.request.mockClear();
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');
    // Let recovery reach its state fetch (channel.join + LiveQuery subscribe
    // precede it) and begin awaiting the held deferred.
    await vi.waitFor(() => {
      expect(multiHub.request).toHaveBeenCalledWith(
        'channel.join',
        expect.anything(),
        expect.anything()
      );
      expect(multiHub.request).toHaveBeenCalledWith('liveQuery.subscribe', expect.anything());
    });
    await new Promise((r) => setTimeout(r, 0));

    // A newer ordinary refresh() resolves immediately and commits first.
    hub.setStateSessionDeferred(null);
    await storeB.refresh();

    // The (older) recovery RPC now resolves — superseded by the newer fetch.
    resolveRpc({
      sessionInfo: { id: 'session-b' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Fresh state was written by the newer fetch → isRecovering cleared.
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('clears isRecovering when a daemon-restart push supersedes the recovery fetch', async () => {
    // P2b: after a daemon restart, revisionAtStart holds the old daemon's high
    // watermark (50) while a new-epoch push resets the gate and applies a low
    // revision (2). The recovery RPC resolving with revision 1 would compare
    // 2 > 50 → false and stall isRecovering; an epoch change must count as fresh.
    hub.setSessionState('session-b', {
      sessionInfo: { id: 'session-b', title: 'pre-restart' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 50,
      daemonEpoch: 'daemon-a',
    });
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.sessionInfo.value?.title).toBe('pre-restart');

    let resolveRpc: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveRpc = res;
      })
    );
    multiHub.request.mockClear();
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(multiHub.request).toHaveBeenCalledWith(
        'channel.join',
        expect.anything(),
        expect.anything()
      );
      expect(multiHub.request).toHaveBeenCalledWith('liveQuery.subscribe', expect.anything());
    });
    await new Promise((r) => setTimeout(r, 0));

    // Daemon restarted: a new-epoch push applies a low revision under epoch 'b'.
    hub.fireChannelEvent(
      'state.session',
      {
        sessionInfo: { id: 'session-b', title: 'post-restart' },
        agentState: { status: 'processing' },
        commandsData: { availableCommands: [] },
        revision: 2,
        daemonEpoch: 'daemon-b',
      },
      'session:session-b'
    );

    // The recovery RPC resolves with an even lower revision (1) under the new
    // epoch — superseded by the push, and across an epoch boundary.
    resolveRpc({
      sessionInfo: { id: 'session-b' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 1,
      daemonEpoch: 'daemon-b',
    });
    await new Promise((r) => setTimeout(r, 30));

    // Epoch change = fresh state → isRecovering cleared; push value wins.
    expect(storeB.isRecovering.value).toBe(false);
    expect(storeB.sessionInfo.value?.title).toBe('post-restart');
  });

  it('ignores a late state.session error from session A after switching to B', async () => {
    // #872 edge case: a reconnect-refresh RPC for the OLD session A resolves
    // (or rejects) AFTER the store switched to B. The error must not surface on
    // B, and B must not be left recovering. A uses retainOnError (returns
    // before any state write on failure), and the generation guard discards a
    // late success too.
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    // Hold A's reconnect-refresh state.session RPC pending, then reconnect.
    let resolveA: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveA = res;
      })
    );
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    // Switch the SAME instance to B (clear the knob so B resolves normally).
    hub.setStateSessionDeferred(null);
    await selectWithSnapshot(storeA, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeA.sessionInfo.value?.id).toBe('session-b');
    expect(storeA.isRecovering.value).toBe(false);

    // A's stale RPC now resolves with an error-shaped result. It must not touch
    // B's state or recovering flag.
    resolveA({
      sessionInfo: null,
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      error: { message: 'A is gone', occurredAt: Date.now() },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(storeA.sessionInfo.value?.id).toBe('session-b');
    expect(storeA.error.value).toBeNull();
    expect(storeA.isRecovering.value).toBe(false);
  });

  it('recovers A and B independently — A dropping never marks B recovering', async () => {
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    // Each instance registered its own onConnection handler; firing a
    // connection event reaches BOTH. A is recovering, but B — whose session is
    // unaffected — must NOT flip its flag (per-session recovery, not global).
    // Note: the connection event is process-wide, so both handlers fire; the
    // invariant is that B's transcript and readiness are untouched by A's drop.
    hub.fireConnection('disconnected');
    // Both see the drop (shared transport) — that's correct, both ARE
    // disconnected. The per-session distinction is exercised by the late-error
    // and soft-resume tests above. Here we assert recovery completes per-store.
    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(storeA.isRecovering.value).toBe(false);
      expect(storeB.isRecovering.value).toBe(false);
    });
    // Each transcript is intact and its own.
    expect(storeA.sdkMessages.value.map((m) => m.uuid)).toEqual(['a1']);
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);
  });

  it('recover() rejoins the session channel and re-subscribes messages together', async () => {
    // Atomicity: a single recover() must restore BOTH the channel membership
    // and the message stream for the SAME session, so URL/route identity,
    // metadata, and the message subscription target one session.
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    multiHub.request.mockClear();
    const subscribesBefore = multiHub.request.mock.calls.filter(
      (c) => c[0] === 'liveQuery.subscribe'
    ).length;

    await storeB.recover();

    // Recovery restores BOTH the session channel (via channel.join) and the
    // message stream for the SAME session.
    expect(multiHub.request).toHaveBeenCalledWith(
      'channel.join',
      { channel: 'session:session-b' },
      expect.anything()
    );
    const subscribesAfter = multiHub.request.mock.calls.filter(
      (c) => c[0] === 'liveQuery.subscribe'
    ).length;
    expect(subscribesAfter).toBe(subscribesBefore + 1);
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('stays recovering when the messages re-subscribe fails, then clears on success', async () => {
    // P1: if the LiveQuery re-subscribe fails during recovery, the new WebSocket
    // client has no message stream — enabling the composer would let a send
    // persist server-side yet never appear here. Recovery must retry, and on
    // final failure leave isRecovering TRUE (composer disabled) until a later
    // reconnect/resume succeeds.
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.isRecovering.value).toBe(false);

    hub.setLiveQuerySubscribeError(new Error('subscribe rejected'));
    // 1 initial subscribe already happened; recovery will retry 3x (3 more).
    const targetSubscribeCalls = hub.subscribeCalls.length + 3;
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    // Wait for the 3 retry attempts to elapse, then assert it is STILL recovering.
    await vi.waitFor(
      () => expect(hub.subscribeCalls.length).toBeGreaterThanOrEqual(targetSubscribeCalls),
      {
        timeout: 5000,
      }
    );
    // Give the final failed attempt + fetchInitialSessionState a tick to settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(storeB.isRecovering.value).toBe(true);
    // The transcript and session identity are untouched — only readiness is held.
    expect(storeB.activeSessionId.value).toBe('session-b');
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);

    // A later successful recovery (subscribe works again) clears the flag.
    hub.setLiveQuerySubscribeError(null);
    hub.fireConnection('connected');
    await vi.waitFor(() => expect(storeB.isRecovering.value).toBe(false));
  });

  it('stays recovering when the session-channel rejoin never succeeds', async () => {
    // P2: if the channel rejoin keeps failing, state.session/context.updated
    // pushes would be missed — recovery must not report readiness. The rejoin
    // retries 3x (3 channel.join attempts) before giving up.
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    const joinsBefore = multiHub.request.mock.calls.filter((c) => c[0] === 'channel.join').length;
    hub.setChannelJoinError(new Error('join rejected'));

    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    // Wait for the 3 rejoin attempts to elapse.
    await vi.waitFor(
      () =>
        expect(
          multiHub.request.mock.calls.filter((c) => c[0] === 'channel.join').length
        ).toBeGreaterThanOrEqual(joinsBefore + 3),
      { timeout: 5000 }
    );
    await new Promise((r) => setTimeout(r, 30));

    // isRecovering stays true — the composer must stay disabled.
    expect(storeB.isRecovering.value).toBe(true);
    expect(storeB.activeSessionId.value).toBe('session-b');
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);
    // P2: a delayed/ambiguous join failure must NOT actively leave the channel
    // (the server may already have restored the membership); only the next
    // recovery re-confirms it.
    expect(multiHub.leaveChannel).not.toHaveBeenCalledWith('session:session-b');

    // A later recovery where the join succeeds clears the flag.
    hub.setChannelJoinError(null);
    hub.fireConnection('connected');
    await vi.waitFor(() => expect(storeB.isRecovering.value).toBe(false));
  });

  it('mergeSnapshotIntoTranscript: preserves the paginated prefix only when the user paginated', () => {
    // preservePrefix mirrors the store's hasPaginatedOlder flag (set when the
    // user loads older messages). With it true, rows older than the snapshot's
    // oldest are kept while the window refreshes in place.
    const existing = [
      { id: 'p1', uuid: 'p1', timestamp: 10, rowid: 1 },
      { id: 'p2', uuid: 'p2', timestamp: 20, rowid: 2 },
      { id: 'w1', uuid: 'w1', timestamp: 100, rowid: 3 },
    ] as never[];
    const snapshot = [
      { id: 'w1', uuid: 'w1', timestamp: 100, rowid: 3 },
      { id: 'w2', uuid: 'w2', timestamp: 110, rowid: 4 },
    ] as never[];
    expect(mergeSnapshotIntoTranscript(existing, snapshot, true).map((m) => m.id)).toEqual([
      'p1',
      'p2',
      'w1',
      'w2',
    ]);
  });

  it('mergeSnapshotIntoTranscript: keeps same-ms prefix rows via the (timestamp, rowid) cursor', () => {
    // The window boundary cuts through a same-millisecond burst: the snapshot's
    // oldest row shares ts=100 with a paginated row, but the cursor orders by
    // (timestamp, rowid), so the older-rowid paginated row must be retained.
    const existing = [
      { id: 'p1', uuid: 'p1', timestamp: 100, rowid: 2 }, // same ms, older rowid
      { id: 'w1', uuid: 'w1', timestamp: 100, rowid: 5 },
    ] as never[];
    const snapshot = [
      { id: 'w1', uuid: 'w1', timestamp: 100, rowid: 5 },
      { id: 'w2', uuid: 'w2', timestamp: 110, rowid: 6 },
    ] as never[];
    expect(mergeSnapshotIntoTranscript(existing, snapshot, true).map((m) => m.id)).toEqual([
      'p1',
      'w1',
      'w2',
    ]);
  });

  it('mergeSnapshotIntoTranscript: tolerates the ±1ms cross-query timestamp jitter at the boundary', () => {
    // The sdkMessages RPC (new Date(ts).getTime()) and the messages.bySession
    // LiveQuery (SQL CAST of a julianday product) can differ by ~1ms for the
    // same instant. A paginated row at the boundary whose measured ts is 1ms
    // NEWER than the snapshot's oldest must still be retained via its older
    // rowid — otherwise the rowid tiebreak is never reached and the row drops.
    const existing = [
      { id: 'p1', uuid: 'p1', timestamp: 101, rowid: 2 }, // jittered +1ms, older rowid
      { id: 'w1', uuid: 'w1', timestamp: 100, rowid: 5 },
    ] as never[];
    const snapshot = [
      { id: 'w1', uuid: 'w1', timestamp: 100, rowid: 5 },
      { id: 'w2', uuid: 'w2', timestamp: 110, rowid: 6 },
    ] as never[];
    expect(mergeSnapshotIntoTranscript(existing, snapshot, true).map((m) => m.id)).toEqual([
      'p1',
      'w1',
      'w2',
    ]);
  });

  it('mergeSnapshotIntoTranscript: replaces wholesale when the user has not paginated, even if many rows returned', () => {
    // The daemon's messages.bySession LIMITs only the top_level CTE then UNIONs
    // unbounded subagent rows, so a complete transcript with <200 top-level
    // messages can still return >=200 rows. Preservation must NOT depend on row
    // count — only on the hasPaginated flag. Without it, deleted/rewound rows
    // are cleared rather than frozen.
    const existing = [
      { id: 'p1', uuid: 'p1', timestamp: 10, rowid: 1 },
      { id: 'w1', uuid: 'w1', timestamp: 100, rowid: 3 },
    ] as never[];
    const snapshot = Array.from({ length: 250 }, (_, i) => ({
      id: `s${i}`,
      uuid: `s${i}`,
      timestamp: 100 + i,
      rowid: 3 + i,
    })) as never[];
    expect(mergeSnapshotIntoTranscript(existing, snapshot, false).map((m) => m.id)).toEqual(
      snapshot.map((r) => (r as { id: string }).id)
    );
  });

  it('mergeSnapshotIntoTranscript: an empty snapshot clears the transcript', () => {
    const existing = [{ id: 'p1', uuid: 'p1', timestamp: 10, rowid: 1 }] as never[];
    expect(mergeSnapshotIntoTranscript(existing, [] as never[], true)).toEqual([]);
  });

  it('mergeSnapshotIntoTranscript: an empty existing transcript just takes the snapshot', () => {
    const snapshot = [
      { id: 'a', uuid: 'a', timestamp: 1, rowid: 1 },
      { id: 'b', uuid: 'b', timestamp: 2, rowid: 2 },
    ] as never[];
    expect(mergeSnapshotIntoTranscript([], snapshot, false).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('a recovery snapshot preserves older rows once the user has paginated', async () => {
    // Integration: prependMessages sets hasPaginatedOlder, so a subsequent
    // recovery/resume snapshot keeps the paginated prefix (older than the
    // window) instead of wholesale-replacing it.
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'w1', uuid: 'w1', type: 'text', role: 'user', timestamp: 100, rowid: 3 },
    ]);
    const subId = hub.subIdFor('session-b');
    storeB.prependMessages([
      { id: 'p1', uuid: 'p1', type: 'text', role: 'user', timestamp: 1, rowid: 0 } as never,
    ]);
    hub.fire('liveQuery.snapshot', {
      subscriptionId: subId,
      rows: [
        { id: 'w1', uuid: 'w1', type: 'text', role: 'user', timestamp: 100, rowid: 3 },
        { id: 'w2', uuid: 'w2', type: 'assistant', timestamp: 110, rowid: 4 },
      ],
    });
    expect(storeB.sdkMessages.value.map((m) => m.id)).toEqual(['p1', 'w1', 'w2']);
  });

  it('recovers the session channel even when the initial load is still in flight', async () => {
    // A tab resume during the initial load (state.session pending, LiveQuery
    // not yet set up → activeMessagesSubscriptionId null) must still rejoin the
    // session channel + refresh state; only the LiveQuery re-subscribe is
    // conditional on a subscription existing.
    let resolveState: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveState = res;
      })
    );
    const selectP = storeB.select('session-b');
    await new Promise((r) => setTimeout(r, 10)); // reach startSubscriptions' state.session await
    expect(storeB.activeMessagesSubscriptionId).toBeNull();

    multiHub.request.mockClear();
    // recover() (called by refreshAllSessionStores on resume) without awaiting:
    // its state refresh also awaits the deferred, so resolve it afterwards.
    const recoverP = storeB.recover();
    await vi.waitFor(() => {
      expect(multiHub.request).toHaveBeenCalledWith(
        'channel.join',
        { channel: 'session:session-b' },
        expect.anything()
      );
    });
    // No LiveQuery re-subscribe was attempted (no subscription yet).
    expect(multiHub.request.mock.calls.filter((c) => c[0] === 'liveQuery.subscribe')).toHaveLength(
      0
    );

    // Let the initial load + recovery settle.
    resolveState({
      sessionInfo: { id: 'session-b' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    hub.setStateSessionDeferred(null);
    await Promise.all([selectP, recoverP]);
  });

  it('does not recover a session switched away from before recover() runs', async () => {
    await selectWithSnapshot(storeB, hub, 'session-x', [
      { id: 'x1', uuid: 'x1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    // Spy recover to capture the moment: switching away first must make the
    // subsequent recover() a no-op for X (no stray channel join / resubscribe).
    await storeB.select('session-y');
    multiHub.joinChannel.mockClear();
    const subscribesBefore = multiHub.request.mock.calls.filter(
      (c) => c[0] === 'liveQuery.subscribe'
    ).length;

    await storeB.recover();

    expect(multiHub.joinChannel).not.toHaveBeenCalledWith('session:session-x');
    const subscribesAfter = multiHub.request.mock.calls.filter(
      (c) => c[0] === 'liveQuery.subscribe'
    ).length;
    // recover() re-subscribes Y (the active session), never X.
    expect(subscribesAfter).toBe(subscribesBefore + 1);
  });
});
