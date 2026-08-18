// @ts-nocheck

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../session-store';
import { isHardUnavailable } from '../session-load-error';

const hub = {
  request: vi.fn(),
  onEvent: vi.fn(),
  onConnection: vi.fn(),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
  isConnected: vi.fn(() => true),
};

let stateSession: (sessionId: string) => Promise<unknown> = async () => ({
  sessionInfo: { id: 's1', status: 'active' },
  agentState: { status: 'idle' },
  commandsData: { availableCommands: [] },
  revision: 1,
});

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(hub)),
    getHubIfConnected: vi.fn(() => hub),
  },
}));

vi.mock('../signals', () => ({ slashCommandsSignal: { value: [] } }));
vi.mock('../toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

function installHub() {
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  hub.request.mockImplementation(async (channel: string, params?: Record<string, unknown>) => {
    if (channel === 'state.session') return stateSession(String(params?.sessionId));
    if (channel === 'liveQuery.subscribe') return { subscriptionId: params?.subscriptionId };
    if (channel === 'liveQuery.unsubscribe') return { ok: true };
    return undefined;
  });
  hub.onEvent.mockImplementation((channel: string, cb: (d: unknown) => void) => {
    const list = eventHandlers.get(channel) ?? [];
    list.push(cb);
    eventHandlers.set(channel, list);
    return () => {
      const l = eventHandlers.get(channel);
      if (!l) return;
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    };
  });
  hub.onConnection.mockImplementation(() => () => {});
  return {
    fire(channel: string, data: unknown, context?: unknown) {
      for (const h of eventHandlers.get(channel) ?? []) h(data, context);
    },
  };
}

describe('SessionStore load-error classification + post-load state', () => {
  let api: ReturnType<typeof installHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    stateSession = async () => ({
      sessionInfo: { id: 's1', status: 'active' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 1,
    });
    api = installHub();
  });

  afterEach(async () => {
    await sessionStore.select(null);
  });

  it('classifies a "Session not found" RPC throw as not-found (hard-unavailable)', async () => {
    stateSession = async () => {
      throw new Error('Session not found');
    };
    await sessionStore.select('deleted-session');
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
    expect(sessionStore.sessionInfo.value).toBeNull();
  });

  it('classifies an RPC null result as not-found', async () => {
    stateSession = async () => null;
    await sessionStore.select('missing-session');
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
  });

  it('classifies a request timeout as timeout (transient — NOT hard-unavailable)', async () => {
    stateSession = async () => {
      throw new Error('Request timeout: state.session (10000ms)');
    };
    await sessionStore.select('slow-session');
    expect(sessionStore.loadErrorKind.value).toBe('timeout');
    expect(isHardUnavailable(sessionStore.loadErrorKind.value)).toBe(false);
  });

  it('classifies a "Not connected" throw as disconnected', async () => {
    stateSession = async () => {
      throw new Error('Not connected to transport');
    };
    await sessionStore.select('offline-session');
    expect(sessionStore.loadErrorKind.value).toBe('disconnected');
    expect(isHardUnavailable(sessionStore.loadErrorKind.value)).toBe(false);
  });

  it('does NOT collapse every failure to "Failed to load session"', async () => {
    stateSession = async () => {
      throw new Error('Session not found');
    };
    await sessionStore.select('x');
    const msg = sessionStore.error.value?.message;
    expect(msg).toBeTruthy();
    expect(msg).not.toBe('Failed to load session');
  });

  it('retainOnError (recovery refresh) does NOT set a hard-unavailable kind', async () => {
    await sessionStore.select('s1');
    expect(sessionStore.loadErrorKind.value).toBeNull();

    stateSession = async () => {
      throw new Error('Request timeout: state.session (10000ms)');
    };
    await sessionStore.refresh();
    expect(sessionStore.loadErrorKind.value).toBeNull();
  });

  it('retainOnError DOES commit an authoritative not-found (deleted while reconnecting)', async () => {
    await sessionStore.select('s1');
    expect(sessionStore.loadErrorKind.value).toBeNull();
    stateSession = async () => {
      throw new Error('Session not found');
    };
    await sessionStore.refresh();
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
  });

  it('reacts to an out-of-band session.deleted event for the active session', async () => {
    await sessionStore.select('s1');
    expect(sessionStore.loadErrorKind.value).toBeNull();
    api.fire('session.deleted', { sessionId: 's1' });
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
  });

  it('ignores session.deleted for a different session', async () => {
    await sessionStore.select('s1');
    api.fire('session.deleted', { sessionId: 'some-other-session' });
    expect(sessionStore.loadErrorKind.value).toBeNull();
  });

  it('a stale state.session push after session.deleted does not revive the session', async () => {
    await sessionStore.select('s1');
    api.fire('session.deleted', { sessionId: 's1' });
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
    api.fire(
      'state.session',
      {
        sessionInfo: { id: 's1', status: 'active' },
        agentState: { status: 'idle' },
        commandsData: { availableCommands: [] },
        revision: 5,
      },
      { channel: 'session:s1' }
    );
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
  });

  it('Try again re-fetches after an out-of-band deletion (not a no-op)', async () => {
    let fetchCount = 0;
    stateSession = async () => {
      fetchCount += 1;
      return {
        sessionInfo: { id: 's1', status: 'active' },
        agentState: { status: 'idle' },
        commandsData: { availableCommands: [] },
        revision: 1,
      };
    };
    await sessionStore.select('s1');
    expect(fetchCount).toBe(1);

    stateSession = async () => {
      fetchCount += 1;
      throw new Error('Session not found');
    };
    api.fire('session.deleted', { sessionId: 's1' });
    await sessionStore.select('s1');
    expect(fetchCount).toBe(2);
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
  });

  it('clears loadErrorKind once a successful push arrives after a transient failure', async () => {
    stateSession = async () => {
      throw new Error('Request timeout: state.session (10000ms)');
    };
    await sessionStore.select('s1');
    expect(sessionStore.loadErrorKind.value).toBe('timeout');

    api.fire(
      'state.session',
      {
        sessionInfo: { id: 's1', status: 'active' },
        agentState: { status: 'idle' },
        commandsData: { availableCommands: [] },
        revision: 2,
      },
      { channel: 'session:s1' }
    );
    expect(sessionStore.loadErrorKind.value).toBeNull();
  });

  it('surfaces an archived session via sessionInfo.status (transcript stays readable)', async () => {
    stateSession = async () => ({
      sessionInfo: { id: 's1', status: 'archived' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 1,
    });
    await sessionStore.select('s1');
    expect(sessionStore.loadErrorKind.value).toBeNull();
    expect(sessionStore.sessionInfo.value?.status).toBe('archived');
  });

  it('resets loadErrorKind on session switch', async () => {
    stateSession = async () => {
      throw new Error('Session not found');
    };
    await sessionStore.select('bad');
    expect(sessionStore.loadErrorKind.value).toBe('not-found');

    stateSession = async () => ({
      sessionInfo: { id: 'good', status: 'active' },
      agentState: { status: 'idle' },
      commandsData: { availableCommands: [] },
      revision: 1,
    });
    await sessionStore.select('good');
    expect(sessionStore.loadErrorKind.value).toBeNull();
  });
});
