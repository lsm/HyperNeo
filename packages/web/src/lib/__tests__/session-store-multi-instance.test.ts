// @ts-nocheck

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SessionStore,
  refreshAllSessionStores,
  mergeSnapshotIntoTranscript,
  markAllSessionStoresRecovering,
  applyOptimisticSessionInfo,
} from '../session-store';

const multiHub = {
  request: vi.fn(),
  onEvent: vi.fn(),
  onConnection: vi.fn(),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
};

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
  fireChannelEvent: (method: string, data: unknown, channel: string) => void;
  fireConnection: (state: string) => void;
  subscribeCalls: Array<{ subscriptionId: string; sessionId: string }>;
  unsubscribeCalls: string[];
  setSessionState: (sessionId: string, state: Record<string, unknown>) => void;
  setStateSessionDeferred: (promise: Promise<unknown> | null) => void;
  setStateSessionError: (error: unknown) => void;
  setLiveQuerySubscribeError: (error: unknown) => void;
  setChannelJoinError: (error: unknown) => void;
  queueStateSession: (promise: Promise<unknown>) => void;
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
  const stateSessionQueue: Array<Promise<unknown>> = [];
  let joinChannelDeferred: Promise<unknown> | null = null;
  let liveQuerySubscribeError: unknown = null;
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
      if (stateSessionQueue.length) return stateSessionQueue.shift()!;
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

    expect(storeA.sessionInfo.value?.title).toBe('Renamed A');
    expect(storeB.sessionInfo.value?.title).toBeUndefined();

    applyOptimisticSessionInfo('session-idle', { title: 'Ignored' });
    expect(storeA.sessionInfo.value?.title).toBe('Renamed A');
  });

  it('applyOptimisticSessionInfo rollback guard preserves newer titles', async () => {
    await storeA.select('session-a');

    applyOptimisticSessionInfo('session-a', { title: 'Optimistic' });
    expect(storeA.sessionInfo.value?.title).toBe('Optimistic');

    applyOptimisticSessionInfo('session-a', { title: 'Old Title' }, 'Optimistic');
    expect(storeA.sessionInfo.value?.title).toBe('Old Title');

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

    expect(storeB.activeSessionId.value).toBeNull();
    expect(storeB.sdkMessages.value).toEqual([]);
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
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).not.toHaveBeenCalled();

    expect(storeA.activeSessionId.value).toBe('session-a');
    expect(storeA.sdkMessages.value.map((m) => m.uuid)).toEqual(['a1']);
    expect(storeB.activeSessionId.value).toBeNull();
  });

  it('leaves its session channel on destroy even if it runs before a queued select(null)', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    multiHub.leaveChannel.mockClear();

    await storeB.destroy();
    expect(multiHub.leaveChannel).toHaveBeenCalledWith('session:session-b');
  });

  it('rapid B→C switch ends on C with no leftover B subscription', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    const bSub = hub.subIdFor('session-b');

    await selectWithSnapshot(storeB, hub, 'session-c', [
      { id: 'c1', uuid: 'c1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    expect(storeB.activeSessionId.value).toBe('session-c');
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['c1']);
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

    hub.setStateSessionError(new Error('transient blip'));
    await storeB.refresh();

    expect(storeB.sessionInfo.value?.title).toBe('good');
    expect(storeB.error.value).toBeNull();
  });

  it('discards a reconnect refresh response that lands after a session switch', async () => {
    await storeB.select('session-b');

    let resolveB: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveB = res;
      })
    );

    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    hub.setStateSessionDeferred(null);
    await storeB.select('session-c');
    expect(storeB.sessionInfo.value?.id).toBe('session-c');

    resolveB({
      sessionInfo: { id: 'session-b', title: 'stale' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(storeB.sessionInfo.value?.id).toBe('session-c');
  });

  it('tears down an in-flight select on destroy and refuses to resurrect', async () => {
    let resolveState: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveState = res;
      })
    );
    const selectP = storeB.select('session-b');
    await new Promise((r) => setTimeout(r, 10));

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

    expect(multiHub.joinChannel).not.toHaveBeenCalledWith('session:session-x');
  });

  it('discards a stale same-session refresh response after a reselect (epoch)', async () => {
    hub.setSessionState('session-x', {
      sessionInfo: { id: 'session-x' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      error: { message: 'boom', occurredAt: 1 },
    });
    await storeB.select('session-x');
    expect(storeB.error.value?.message).toBe('boom');

    let resolveReconnect: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveReconnect = res;
      })
    );
    hub.fireConnection('connected');

    hub.setStateSessionDeferred(null);
    hub.setSessionState('session-x', {
      sessionInfo: { id: 'session-x', title: 'recovered' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await storeB.select('session-x');
    expect(storeB.sessionInfo.value?.title).toBe('recovered');

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

    let resolveGood: (value: unknown) => void = () => {};
    hub.queueStateSession(
      new Promise((res) => {
        resolveGood = res;
      })
    );
    hub.queueStateSession(Promise.reject(new Error('transient blip')));

    const rGood = storeB.refresh();
    const rFail = storeB.refresh();
    await new Promise((r) => setTimeout(r, 10));

    resolveGood({
      sessionInfo: { id: 'session-b', title: 'recovered' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
    });
    await Promise.allSettled([rGood, rFail]);

    expect(storeB.sessionInfo.value?.title).toBe('recovered');
    expect(storeB.error.value).toBeNull();
  });

  it('releases a session channel whose retrying join succeeded after a switch', async () => {
    await selectWithSnapshot(storeB, hub, 'session-x', [
      { id: 'x1', uuid: 'x1', type: 'text', role: 'user', timestamp: 1 },
    ]);

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
    await new Promise((r) => setTimeout(r, 10));

    hub.setJoinChannelDeferred(null);
    hub.setStateSessionDeferred(null);
    await storeB.select('session-y');

    const leavesXBefore = multiHub.leaveChannel.mock.calls.filter(
      (c) => c[0] === 'session:session-x'
    ).length;
    expect(leavesXBefore).toBeGreaterThanOrEqual(1);

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

    let resolveRpc: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveRpc = res;
      })
    );
    const refreshP = storeB.refresh();
    await new Promise((r) => setTimeout(r, 10));

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
    hub.setSessionState('session-x', {
      sessionInfo: { id: 'session-x', title: 'pre-restart' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 50,
      daemonEpoch: 'daemon-a',
    });
    await storeB.select('session-x');
    expect(storeB.sessionInfo.value?.title).toBe('pre-restart');

    hub.setSessionState('session-x', {
      sessionInfo: { id: 'session-x', title: 'post-restart' },
      agentState: { status: 'processing' },
      commandsData: { availableCommands: [] },
      revision: 1,
      daemonEpoch: 'daemon-b',
    });
    await storeB.refresh();

    expect(storeB.sessionInfo.value?.title).toBe('post-restart');
    expect(storeB.agentState.value.status).toBe('processing');
  });

  it('a partial context.updated push guards only contextInfo, not the full-state fetch', async () => {
    let resolveRpc: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveRpc = res;
      })
    );
    const selectP = storeB.select('session-x');
    await new Promise((r) => setTimeout(r, 10));

    hub.fireChannelEvent(
      'context.updated',
      { inputTokens: 999, outputTokens: 1 },
      'session:session-x'
    );
    expect(storeB.contextInfo.value).toEqual({ inputTokens: 999, outputTokens: 1 });

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

    expect(storeB.sessionInfo.value?.title).toBe('loaded');
    expect(storeB.contextInfo.value).toEqual({ inputTokens: 999, outputTokens: 1 });
  });

  it('is not recovering once a session is loaded normally', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('markAllSessionStoresRecovering flags active stores synchronously (resume window)', async () => {
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

    await refreshAllSessionStores();
    expect(storeA.isRecovering.value).toBe(false);
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('flips isRecovering on transport drop and clears it once recovery settles', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.isRecovering.value).toBe(false);

    hub.fireConnection('disconnected');
    expect(storeB.isRecovering.value).toBe(true);

    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(storeB.isRecovering.value).toBe(false);
    });
  });

  it('clears isRecovering when reconnects are permanently exhausted (failed)', async () => {
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

    hub.fireConnection('connected');
    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(storeB.isRecovering.value).toBe(false);
    });
  });

  it('soft-resume (refreshAllSessionStores) re-establishes the messages LiveQuery', async () => {
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
    const resubscribe = multiHub.request.mock.calls
      .filter((c) => c[0] === 'liveQuery.subscribe')
      .slice(-1)[0];
    expect(resubscribe?.[1]).toMatchObject({
      queryName: 'messages.bySession',
      params: ['session-b', expect.any(Number)],
    });
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

    hub.setStateSessionError(new Error('transient blip'));
    await refreshAllSessionStores();
    expect(storeB.sessionInfo.value?.title).toBe('good');
    expect(storeB.error.value).toBeNull();
    expect(storeB.isRecovering.value).toBe(true);

    hub.setStateSessionError(null);
    await refreshAllSessionStores();
    expect(storeB.isRecovering.value).toBe(false);
  });

  it('clears isRecovering when a newer state push supersedes the recovery fetch', async () => {
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

    await vi.waitFor(() => {
      expect(multiHub.request).toHaveBeenCalledWith(
        'channel.join',
        expect.anything(),
        expect.anything()
      );
      expect(multiHub.request).toHaveBeenCalledWith('liveQuery.subscribe', expect.anything());
    });
    await new Promise((r) => setTimeout(r, 0));

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

    resolveRpc({
      sessionInfo: { id: 'session-b', title: 'stale-rpc' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 4,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(storeB.isRecovering.value).toBe(false);
    expect(storeB.sessionInfo.value?.title).toBe('pushed');
    expect(storeB.agentState.value.status).toBe('processing');
  });

  it('clears isRecovering when an overlapping refresh supersedes the recovery fetch', async () => {
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
    await vi.waitFor(() => {
      expect(multiHub.request).toHaveBeenCalledWith(
        'channel.join',
        expect.anything(),
        expect.anything()
      );
      expect(multiHub.request).toHaveBeenCalledWith('liveQuery.subscribe', expect.anything());
    });
    await new Promise((r) => setTimeout(r, 0));

    hub.setStateSessionDeferred(null);
    await storeB.refresh();

    resolveRpc({
      sessionInfo: { id: 'session-b' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(storeB.isRecovering.value).toBe(false);
  });

  it('clears isRecovering when a daemon-restart push supersedes the recovery fetch', async () => {
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

    resolveRpc({
      sessionInfo: { id: 'session-b' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 1,
      daemonEpoch: 'daemon-b',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(storeB.isRecovering.value).toBe(false);
    expect(storeB.sessionInfo.value?.title).toBe('post-restart');
  });

  it('ignores a late state.session error from session A after switching to B', async () => {
    await selectWithSnapshot(storeA, hub, 'session-a', [
      { id: 'a1', uuid: 'a1', type: 'text', role: 'user', timestamp: 1 },
    ]);

    let resolveA: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveA = res;
      })
    );
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    hub.setStateSessionDeferred(null);
    await selectWithSnapshot(storeA, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeA.sessionInfo.value?.id).toBe('session-b');
    expect(storeA.isRecovering.value).toBe(false);

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

    hub.fireConnection('disconnected');
    hub.fireConnection('connected');
    await vi.waitFor(() => {
      expect(storeA.isRecovering.value).toBe(false);
      expect(storeB.isRecovering.value).toBe(false);
    });
    expect(storeA.sdkMessages.value.map((m) => m.uuid)).toEqual(['a1']);
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);
  });

  it('recover() rejoins the session channel and re-subscribes messages together', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    multiHub.request.mockClear();
    const subscribesBefore = multiHub.request.mock.calls.filter(
      (c) => c[0] === 'liveQuery.subscribe'
    ).length;

    await storeB.recover();

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
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    expect(storeB.isRecovering.value).toBe(false);

    hub.setLiveQuerySubscribeError(new Error('subscribe rejected'));
    const targetSubscribeCalls = hub.subscribeCalls.length + 3;
    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    await vi.waitFor(
      () => expect(hub.subscribeCalls.length).toBeGreaterThanOrEqual(targetSubscribeCalls),
      {
        timeout: 5000,
      }
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(storeB.isRecovering.value).toBe(true);
    expect(storeB.activeSessionId.value).toBe('session-b');
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);

    hub.setLiveQuerySubscribeError(null);
    hub.fireConnection('connected');
    await vi.waitFor(() => expect(storeB.isRecovering.value).toBe(false));
  });

  it('stays recovering when the session-channel rejoin never succeeds', async () => {
    await selectWithSnapshot(storeB, hub, 'session-b', [
      { id: 'b1', uuid: 'b1', type: 'text', role: 'user', timestamp: 1 },
    ]);
    const joinsBefore = multiHub.request.mock.calls.filter((c) => c[0] === 'channel.join').length;
    hub.setChannelJoinError(new Error('join rejected'));

    hub.fireConnection('disconnected');
    hub.fireConnection('connected');

    await vi.waitFor(
      () =>
        expect(
          multiHub.request.mock.calls.filter((c) => c[0] === 'channel.join').length
        ).toBeGreaterThanOrEqual(joinsBefore + 3),
      { timeout: 5000 }
    );
    await new Promise((r) => setTimeout(r, 30));

    expect(storeB.isRecovering.value).toBe(true);
    expect(storeB.activeSessionId.value).toBe('session-b');
    expect(storeB.sdkMessages.value.map((m) => m.uuid)).toEqual(['b1']);
    expect(multiHub.leaveChannel).not.toHaveBeenCalledWith('session:session-b');

    hub.setChannelJoinError(null);
    hub.fireConnection('connected');
    await vi.waitFor(() => expect(storeB.isRecovering.value).toBe(false));
  });

  it('mergeSnapshotIntoTranscript: preserves the paginated prefix only when the user paginated', () => {
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
    const existing = [
      { id: 'p1', uuid: 'p1', timestamp: 100, rowid: 2 },
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
    const existing = [
      { id: 'p1', uuid: 'p1', timestamp: 101, rowid: 2 },
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
    let resolveState: (value: unknown) => void = () => {};
    hub.setStateSessionDeferred(
      new Promise((res) => {
        resolveState = res;
      })
    );
    const selectP = storeB.select('session-b');
    await new Promise((r) => setTimeout(r, 10));
    expect(storeB.activeMessagesSubscriptionId).toBeNull();

    multiHub.request.mockClear();
    const recoverP = storeB.recover();
    await vi.waitFor(() => {
      expect(multiHub.request).toHaveBeenCalledWith(
        'channel.join',
        { channel: 'session:session-b' },
        expect.anything()
      );
    });
    expect(multiHub.request.mock.calls.filter((c) => c[0] === 'liveQuery.subscribe')).toHaveLength(
      0
    );

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
    expect(subscribesAfter).toBe(subscribesBefore + 1);
  });
});
