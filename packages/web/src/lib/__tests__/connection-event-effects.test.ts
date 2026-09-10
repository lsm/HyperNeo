import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../connection-manager';

const fixture = vi.hoisted(() => ({
  effects: [] as string[],
  state: 'disconnected',
  attempts: 7,
  connected: true,
  emit: (_state: string, _error?: Error) => {},
}));

vi.mock('@hyperneo/shared', () => ({
  MessageHub: class {
    onConnection(callback: typeof fixture.emit) {
      fixture.emit = callback;
      return () => {};
    }
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
vi.mock('../space-store', () => ({ spaceStore: {} }));
vi.mock('../space-agent-store', () => ({
  spaceAgentStore: {
    recover() {
      fixture.effects.push('recover-agents');
      return new Promise(() => {});
    },
  },
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
  });

  it('runs connected effects synchronously in order without waiting for agent recovery', () => {
    fixture.emit('connected');
    expect(fixture.effects).toEqual([
      'state:connected',
      'attempts:0',
      'start-actions',
      'start-audio',
      'start-transcripts',
      'notify',
      'recover-agents',
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
    expect(fixture.effects.slice(-4)).toEqual([
      'notify',
      'throwing-listener',
      'last-listener',
      'recover-agents',
    ]);
  });
});
