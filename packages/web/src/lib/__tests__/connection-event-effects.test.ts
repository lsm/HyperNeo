import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../connection-manager';

const fixture = vi.hoisted(() => ({
  effects: [] as string[],
  state: 'disconnected',
  attempts: 7,
  connected: true,
  build: vi.fn(async () => ({ commit: 'a'.repeat(40) })),
  emit: (_state: string, _error?: Error) => {},
}));

vi.mock('@hyperneo/shared', () => ({
  MessageHub: class {
    onConnection(callback: typeof fixture.emit) {
      fixture.emit = callback;
      return () => {};
    }
    request = fixture.build;
    isConnected() {
      return fixture.connected;
    }
    registerTransport() {}
    joinChannel() {}
  },
  WebSocketClientTransport: class {
    async initialize() {}
    isReady() {
      return true;
    }
    close() {
      fixture.effects.push('close');
    }
    getReconnectAttempts() {
      fixture.effects.push('read-attempts');
      return 3;
    }
  },
}));
vi.mock('../state', () => ({
  appState: {},
  connectionState: {
    get value() {
      return fixture.state;
    },
    set value(value: string) {
      fixture.state = value;
      fixture.effects.push(`state:${value}`);
    },
  },
  reconnectAttemptCount: {
    get value() {
      return fixture.attempts;
    },
    set value(value: number) {
      fixture.attempts = value;
      fixture.effects.push(`attempts:${value}`);
    },
  },
}));
vi.mock('../global-store', () => ({ globalStore: {} }));
vi.mock('../session-store', () => ({ sessionStore: {} }));
vi.mock('../space-store', () => ({
  spaceStore: { rejoinChannel: () => fixture.effects.push('rejoin-space') },
}));
vi.mock('../signals', () => ({ currentSessionIdSignal: {}, slashCommandsSignal: {} }));
vi.mock('../outbound-queue', () => ({
  startAutoFlush: () => fixture.effects.push('start-actions'),
  stopAutoFlush: () => fixture.effects.push('stop-actions'),
}));
vi.mock('../voice/voice-audio-outbox', () => ({
  startVoiceAudioOutboxFlush: () => fixture.effects.push('start-audio'),
  stopVoiceAudioOutboxFlush: () => fixture.effects.push('stop-audio'),
}));
vi.mock('../voice/voice-transcript-outbox', () => ({
  startVoiceTranscriptOutboxFlush: () => fixture.effects.push('start-transcripts'),
  stopVoiceTranscriptOutboxFlush: () => fixture.effects.push('stop-transcripts'),
}));

describe('real ConnectionManager connection-event effects', () => {
  let manager: ConnectionManager;

  beforeEach(async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    fixture.build.mockReset().mockResolvedValue({ commit: 'a'.repeat(40) });
    fixture.connected = true;
    fixture.state = 'disconnected';
    fixture.attempts = 7;
    manager = new ConnectionManager('ws://example.test');
    await manager.getHub();
    fixture.connected = false;
    manager.onceConnected(() => fixture.effects.push('notify'));
    fixture.connected = true;
    fixture.effects.length = 0;
    fixture.state = 'reconnecting';
  });

  afterEach(async () => {
    await manager.disconnect();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reloads the running bundle when reconnect reports a different daemon commit', async () => {
    vi.stubGlobal('__WEB_BUILD_COMMIT__', 'a'.repeat(40));
    window.location.reload = vi.fn();
    fixture.build.mockResolvedValueOnce({ commit: 'a'.repeat(40) });
    fixture.emit('connected');
    await vi.waitFor(() => expect(fixture.build).toHaveBeenCalled());
    expect(window.location.reload).not.toHaveBeenCalled();
    fixture.build.mockResolvedValueOnce({ commit: 'b'.repeat(40) });
    fixture.emit('reconnecting');
    fixture.emit('connected');
    await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalledOnce());
    expect(fixture.build).toHaveBeenLastCalledWith('operation.invoke', {
      name: 'system.build',
      input: {},
    });
  });

  it('reloads only once for a persistent commit pair, across page initialization and reconnects', async () => {
    vi.stubGlobal('__WEB_BUILD_COMMIT__', 'a'.repeat(40));
    window.location.reload = vi.fn();
    fixture.build.mockResolvedValue({ commit: 'b'.repeat(40) });
    fixture.emit('connected');
    await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalledOnce());
    await manager.disconnect();
    manager = new ConnectionManager('ws://example.test');
    await manager.getHub();
    fixture.emit('connected');
    fixture.emit('connected');
    await vi.waitFor(() => expect(fixture.build).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.reload).toHaveBeenCalledOnce();
    fixture.build.mockResolvedValue({ commit: 'c'.repeat(40) });
    fixture.emit('connected');
    await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalledTimes(2));
    fixture.build.mockResolvedValue({ commit: 'b'.repeat(40) });
    fixture.emit('connected');
    await vi.waitFor(() => expect(fixture.build).toHaveBeenCalledTimes(5));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.reload).toHaveBeenCalledTimes(2);
  });

  it.each(['getItem', 'setItem'])(
    'keeps the page when session storage %s is blocked',
    async (method) => {
      vi.stubGlobal('__WEB_BUILD_COMMIT__', 'a'.repeat(40));
      window.location.reload = vi.fn();
      vi.spyOn(sessionStorage, method).mockImplementation(() => {
        throw new Error('storage unavailable');
      });
      fixture.build.mockResolvedValue({ commit: 'b'.repeat(40) });
      fixture.emit('connected');
      await vi.waitFor(() => expect(fixture.build).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(window.location.reload).not.toHaveBeenCalled();
    }
  );

  it.each(['unknown', '', undefined])(
    'keeps the page when the daemon commit is %s',
    async (commit) => {
      vi.stubGlobal('__WEB_BUILD_COMMIT__', 'a'.repeat(40));
      window.location.reload = vi.fn();
      fixture.build.mockResolvedValueOnce({ commit } as { commit: string });
      fixture.emit('connected');
      await vi.waitFor(() => expect(fixture.build).toHaveBeenCalled());
      expect(window.location.reload).not.toHaveBeenCalled();
    }
  );

  it('keeps the page when build discovery fails, then retries on reconnect', async () => {
    vi.stubGlobal('__WEB_BUILD_COMMIT__', 'a'.repeat(40));
    window.location.reload = vi.fn();
    fixture.build.mockRejectedValueOnce(new Error('disconnected'));
    fixture.emit('connected');
    await vi.waitFor(() => expect(fixture.build).toHaveBeenCalled());
    expect(window.location.reload).not.toHaveBeenCalled();
    fixture.build.mockResolvedValueOnce({ commit: 'b'.repeat(40) });
    fixture.emit('connected');
    await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalledOnce());
  });

  it('runs connected effects synchronously in order', () => {
    fixture.emit('connected');
    expect(fixture.effects).toEqual([
      'state:connected',
      'attempts:0',
      'start-actions',
      'start-audio',
      'start-transcripts',
      'rejoin-space',
      'notify',
    ]);
    expect(fixture.state).toBe('connected');
    expect(fixture.attempts).toBe(0);
  });

  it('only notifies during resume, even if the connected event carries an auth error', () => {
    Reflect.set(manager, '_isResuming', true);
    fixture.emit('connected', new Error('HTTP 401 Unauthorized'));
    expect(fixture.effects).toEqual(['notify']);
    expect(fixture.state).toBe('reconnecting');
    expect(fixture.attempts).toBe(7);
  });

  it.each(['connecting', 'reconnecting'])(
    'updates state before reading attempts for %s',
    (state) => {
      fixture.emit(state);
      expect(fixture.effects).toEqual([`state:${state}`, 'read-attempts', 'attempts:3']);
    }
  );

  it.each(['disconnected', 'failed', 'error'])('only publishes state for ordinary %s', (state) => {
    fixture.emit(state, new Error('network unavailable'));
    expect(fixture.effects).toEqual([`state:${state}`]);
    expect(fixture.attempts).toBe(7);
  });

  it('does not classify a missing error as authentication failure', () => {
    fixture.emit('error');
    expect(fixture.effects).toEqual(['state:error']);
  });

  it('stops all queues before closing and redirecting on authentication failure', () => {
    vi.spyOn(window.location, 'search', 'get').mockReturnValue('');
    vi.spyOn(window.location, 'href', 'set').mockImplementation((href) => {
      fixture.effects.push(`navigate:${href}`);
    });
    fixture.emit('error', new Error('HTTP 401 Unauthorized'));
    expect(fixture.effects).toEqual([
      'state:error',
      'stop-actions',
      'stop-audio',
      'stop-transcripts',
      'close',
      'navigate:/settings?tab=providers&reason=session_expired',
    ]);
    expect(fixture.attempts).toBe(7);
  });

  it('suppresses repeat redirects but still stops queues and closes transport during resume', () => {
    Reflect.set(manager, '_isResuming', true);
    vi.spyOn(window.location, 'search', 'get').mockReturnValue('?reason=session_expired');
    const navigate = vi.spyOn(window.location, 'href', 'set').mockImplementation(() => {});
    fixture.emit('error', new Error('Session expired'));
    expect(fixture.effects).toEqual([
      'state:error',
      'stop-actions',
      'stop-audio',
      'stop-transcripts',
      'close',
    ]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('continues notification and recovery after a listener throws', () => {
    fixture.connected = false;
    manager.onceConnected(() => {
      fixture.effects.push('throwing-listener');
      throw new Error('listener');
    });
    manager.onceConnected(() => fixture.effects.push('last-listener'));
    fixture.connected = true;
    fixture.emit('connected');
    expect(fixture.effects.slice(-3)).toEqual(['notify', 'throwing-listener', 'last-listener']);
  });
});
