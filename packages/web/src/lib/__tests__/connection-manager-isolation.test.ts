import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../connection-manager';
import type { ConnectionApplication } from '../connection-application';
import type { ConnectionState } from '../state';

const fixtures = vi.hoisted(() => ({
  hubs: [] as Array<{
    emit(state: ConnectionState, error?: Error): void;
    request: ReturnType<typeof vi.fn>;
    joinChannel: ReturnType<typeof vi.fn>;
  }>,
  transports: [] as Array<{
    ready: boolean;
    close: ReturnType<typeof vi.fn>;
    forceReconnect: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('../signals', () => ({ currentSessionIdSignal: {}, slashCommandsSignal: {} }));
vi.mock('../connection-application', () => ({
  createDefaultConnectionApplication: () => makeApplication('default').application,
}));
vi.mock('@hyperneo/shared', () => ({
  MessageHub: class {
    private listeners = new Set<(state: ConnectionState, error?: Error) => void>();
    private connected = true;
    request = vi.fn(async () => {});
    joinChannel = vi.fn(async () => {});
    constructor() {
      fixtures.hubs.push(this);
    }
    onConnection(callback: (state: ConnectionState, error?: Error) => void) {
      this.listeners.add(callback);
      return () => this.listeners.delete(callback);
    }
    registerTransport() {}
    isConnected() {
      return this.connected;
    }
    emit(state: ConnectionState, error?: Error) {
      this.connected = state === 'connected';
      for (const listener of this.listeners) listener(state, error);
    }
  },
  WebSocketClientTransport: class {
    ready = true;
    close = vi.fn(() => {
      this.ready = false;
    });
    forceReconnect = vi.fn(() => {
      this.ready = false;
    });
    constructor() {
      fixtures.transports.push(this);
    }
    async initialize() {}
    isReady() {
      return this.ready;
    }
    getReconnectAttempts() {
      return 3;
    }
  },
}));

function makeApplication(spaceId: string) {
  let state: ConnectionState = 'disconnected';
  const lifecycle = {
    getState: () => state,
    setState: vi.fn((next: ConnectionState) => {
      state = next;
    }),
    startActions: vi.fn(),
    stopActions: vi.fn(),
    startAudio: vi.fn(),
    stopAudio: vi.fn(),
    startTranscripts: vi.fn(),
    stopTranscripts: vi.fn(),
    exposeHub: vi.fn(),
    markHubReady: vi.fn(),
  };
  const recover = vi.fn(async () => {});
  const redirect = vi.fn();
  const refresh = vi.fn(async () => {});
  const mark = vi.fn();
  const application: ConnectionApplication = {
    lifecycle,
    createEventEffects: (owner) => ({
      ...lifecycle,
      ...owner,
      setReconnectAttempts: vi.fn(),
      redirectExpiredSession: redirect,
      recoverAgents: recover,
    }),
    createResumeEffects: (owner) => ({
      ...owner,
      getActiveSpaceId: () => spaceId,
      refreshSessions: refresh,
      refreshApp: refresh,
      refreshGlobal: refresh,
      refreshSpace: refresh,
      recoverAgents: recover,
    }),
    markSessionsRecovering: mark,
  };
  return { application, lifecycle, recover, redirect, refresh, mark };
}

describe('ConnectionManager with separate applications', () => {
  const managers: ConnectionManager[] = [];
  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.disconnect();
    fixtures.hubs.length = 0;
    fixtures.transports.length = 0;
    vi.restoreAllMocks();
  });

  async function connectPair() {
    const a = makeApplication('space-a');
    const b = makeApplication('space-b');
    const first = new ConnectionManager('ws://a.test', a.application);
    const second = new ConnectionManager('ws://b.test', b.application);
    managers.push(first, second);
    const [firstHub, secondHub] = await Promise.all([first.getHub(), second.getHub()]);
    expect(firstHub).not.toBe(secondHub);
    expect(a.lifecycle.exposeHub).toHaveBeenCalledWith(firstHub, first);
    expect(b.lifecycle.exposeHub).toHaveBeenCalledWith(secondHub, second);
    vi.clearAllMocks();
    return { a, b, first, second };
  }

  it('routes events, waiters, auth failure, and shutdown to their own application', async () => {
    const { a, b, first, second } = await connectPair();
    const [hubA, hubB] = fixtures.hubs;
    hubA.emit('reconnecting');
    hubB.emit('reconnecting');
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    first.onceConnected(notifyA);
    second.onceConnected(notifyB);
    hubA.emit('connected');
    expect(first.getConnectionState()).toBe('connected');
    expect(second.getConnectionState()).toBe('reconnecting');
    expect(notifyA).toHaveBeenCalledOnce();
    expect(notifyB).not.toHaveBeenCalled();
    expect(a.lifecycle.startActions).toHaveBeenCalledOnce();
    expect(a.recover).toHaveBeenCalledOnce();
    expect(b.lifecycle.startActions).not.toHaveBeenCalled();
    expect(b.recover).not.toHaveBeenCalled();
    hubA.emit('error', new Error('HTTP 401 Unauthorized'));
    expect(a.redirect).toHaveBeenCalledOnce();
    expect(a.lifecycle.stopAudio).toHaveBeenCalledOnce();
    expect(fixtures.transports[0].close).toHaveBeenCalledOnce();
    expect(fixtures.transports[1].close).not.toHaveBeenCalled();
    expect(b.redirect).not.toHaveBeenCalled();
    hubB.emit('connected');
    expect(notifyB).toHaveBeenCalledOnce();
    expect(second.getConnectionState()).toBe('connected');
    await first.disconnect();
    expect(second.getHubIfConnected()).not.toBeNull();
    expect(second.getConnectionState()).toBe('connected');
    expect(b.lifecycle.stopActions).not.toHaveBeenCalled();
    expect(b.lifecycle.stopAudio).not.toHaveBeenCalled();
    expect(b.lifecycle.stopTranscripts).not.toHaveBeenCalled();
  });

  it('can recover one manager while another is held, and confines failed recovery', async () => {
    const { a, b, first, second } = await connectPair();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    a.refresh.mockImplementation(() => held);
    const resume = (manager: ConnectionManager) =>
      (Reflect.get(manager, 'validateConnectionOnResume') as () => Promise<void>).call(manager);
    fixtures.hubs[0].emit('reconnecting');
    fixtures.hubs[1].emit('reconnecting');
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    first.onceConnected(notifyA);
    second.onceConnected(notifyB);
    const pendingA = resume(first);
    await resume(second);
    await setImmediate();
    expect(a.mark).toHaveBeenCalledOnce();
    expect(b.mark).toHaveBeenCalledOnce();
    expect(fixtures.hubs[0].request).toHaveBeenCalledWith('system.health', {}, { timeout: 3000 });
    expect(fixtures.hubs[1].request).toHaveBeenCalledWith('system.health', {}, { timeout: 3000 });
    expect(fixtures.hubs[0].joinChannel.mock.calls).toEqual([['global'], ['space:space-a']]);
    expect(fixtures.hubs[1].joinChannel.mock.calls).toEqual([['global'], ['space:space-b']]);
    expect(a.refresh).toHaveBeenCalledTimes(4);
    expect(b.refresh).toHaveBeenCalledTimes(4);
    expect(notifyA).not.toHaveBeenCalled();
    expect(notifyB).toHaveBeenCalledOnce();
    expect(first.getConnectionState()).toBe('reconnecting');
    expect(second.getConnectionState()).toBe('connected');
    release();
    await pendingA;
    expect(notifyA).toHaveBeenCalledOnce();
    expect(first.getConnectionState()).toBe('connected');
    a.refresh.mockRejectedValue(new Error('refresh failed'));
    await resume(first);
    expect(fixtures.transports[0].forceReconnect).toHaveBeenCalledOnce();
    expect(fixtures.transports[1].forceReconnect).not.toHaveBeenCalled();
    expect(b.refresh).toHaveBeenCalledTimes(4);
    expect(second.getConnectionState()).toBe('connected');
    expect(second.getHubIfConnected()).not.toBeNull();
  });
});
