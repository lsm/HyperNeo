// @ts-nocheck
/**
 * SessionStore load-error classification + post-load state (task #873).
 *
 * Verifies the store preserves backend error distinctions instead of collapsing
 * every load failure into "Failed to load session", that transient recovery
 * refreshes do NOT set a hard-unavailable kind (so the cached transcript is
 * retained), and that archived/terminated surface via `sessionInfo.status`.
 *
 * Note: the hub mock resolves `liveQuery.subscribe` without firing a snapshot,
 * so `messagesLoaded` stays false here — that's fine, these tests target the
 * `state.session` load outcome (`loadErrorKind`), which is settled by the time
 * the awaited `select()` returns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../session-store';
import { isHardUnavailable } from '../session-load-error';

// Configurable hub: stateSession controls the `state.session` RPC behaviour.
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
    // Transient kinds must not be treated as hard-unavailable — the load-error
    // view owns them, and a recovering retry can still succeed.
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
    // First load succeeds.
    await sessionStore.select('s1');
    expect(sessionStore.loadErrorKind.value).toBeNull();

    // A recovery refresh fails transiently — it must retain state and NOT flip
    // the kind to not-found/timeout (which would strand the live session on the
    // unavailable screen).
    stateSession = async () => {
      throw new Error('Request timeout: state.session (10000ms)');
    };
    await sessionStore.refresh();
    expect(sessionStore.loadErrorKind.value).toBeNull();
  });

  it('retainOnError DOES commit an authoritative not-found (deleted while reconnecting)', async () => {
    // First load succeeds, then the session is deleted server-side during a
    // reconnect/resume refresh. An authoritative "Session not found" must NOT be
    // retained — the session is gone, so surface the unavailable state instead
    // of looping forever on a cached ghost transcript.
    await sessionStore.select('s1');
    expect(sessionStore.loadErrorKind.value).toBeNull();
    stateSession = async () => {
      throw new Error('Session not found');
    };
    await sessionStore.refresh();
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
  });

  it('reacts to an out-of-band session.deleted event for the active session', async () => {
    // Load succeeds; then another tab/client deletes the session. The daemon
    // publishes session.deleted globally — the store must flip to not-found so
    // the view doesn't keep interacting with a stale session.
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
    // Deletion arrives, THEN a state.session push captured before the deletion
    // lands late. The tombstone must stop it from clearing loadErrorKind and
    // reviving the deleted transcript.
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

    // Deleted out-of-band; the cached sessionState is still the pre-deletion
    // success, so the alreadyLoaded guard would normally no-op a re-select.
    stateSession = async () => {
      fetchCount += 1;
      throw new Error('Session not found');
    };
    api.fire('session.deleted', { sessionId: 's1' });
    await sessionStore.select('s1');
    // The retry must bypass the guard and re-issue the load (server re-confirms
    // not-found).
    expect(fetchCount).toBe(2);
    expect(sessionStore.loadErrorKind.value).toBe('not-found');
  });

  it('clears loadErrorKind once a successful push arrives after a transient failure', async () => {
    stateSession = async () => {
      throw new Error('Request timeout: state.session (10000ms)');
    };
    await sessionStore.select('s1');
    expect(sessionStore.loadErrorKind.value).toBe('timeout');

    // A later state.session push with a live sessionInfo recovers the view.
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
    // Archived is NOT a load error — the RPC succeeds, so loadErrorKind stays
    // null and the UI reads the status directly for the archived banner.
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
