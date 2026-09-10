import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../connection-manager';

const fixture = vi.hoisted(() => ({
  effects: [] as string[],
  connected: false,
  initialize: (): Promise<void> => Promise.resolve(),
  listeners: new Set<(state: string) => void>(),
}));

vi.mock('@hyperneo/shared', () => ({
  MessageHub: class {
    constructor() {
      fixture.effects.push('create-hub');
    }
    onConnection(callback: (state: string) => void) {
      fixture.listeners.add(callback);
      return () => fixture.listeners.delete(callback);
    }
    isConnected() {
      return fixture.connected;
    }
    registerTransport() {
      fixture.effects.push('register-transport');
    }
    joinChannel(channel: string) {
      fixture.effects.push(`join:${channel}`);
      return new Promise<void>(() => {});
    }
  },
  WebSocketClientTransport: class {
    constructor(options: { url: string }) {
      fixture.effects.push(`transport:${options.url}`);
    }
    initialize() {
      fixture.effects.push('initialize');
      return fixture.initialize();
    }
    isReady() {
      return fixture.connected;
    }
    close() {
      fixture.effects.push('close');
    }
    getReconnectAttempts() {
      return 0;
    }
  },
}));
vi.mock('../state', () => ({
  appState: {},
  connectionState: {
    set value(state: string) {
      fixture.effects.push(`state:${state}`);
    },
  },
  reconnectAttemptCount: { value: 0 },
}));
vi.mock('../global-store', () => ({ globalStore: {} }));
vi.mock('../session-store', () => ({ sessionStore: {} }));
vi.mock('../space-store', () => ({ spaceStore: {} }));
vi.mock('../space-agent-store', () => ({
  spaceAgentStore: { recover: async () => {} },
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

const startup = [
  'state:connecting',
  'create-hub',
  'transport:ws://example.test/ws',
  'register-transport',
  'start-audio',
  'start-transcripts',
  'initialize',
];

function emit(state: string) {
  fixture.connected = state === 'connected';
  for (const listener of [...fixture.listeners]) listener(state);
}

describe('real ConnectionManager startup and shutdown', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    fixture.effects = [];
    fixture.connected = false;
    fixture.listeners.clear();
    fixture.initialize = () => Promise.resolve();
    manager = new ConnectionManager('ws://example.test');
  });

  afterEach(async () => {
    await manager.disconnect();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shares pending initialization and completes without waiting for the global join', async () => {
    let release!: () => void;
    fixture.initialize = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const first = manager.getHub();
    const second = manager.getHub();
    await setImmediate();
    expect(fixture.effects).toEqual(startup);
    expect(window.__messageHubReady).toBe(false);
    expect(manager.getHubIfConnected()).toBeNull();
    fixture.connected = true;
    release();
    const hub = await first;
    expect(await second).toBe(hub);
    expect(await manager.getHub()).toBe(hub);
    expect(manager.getHubIfConnected()).toBe(hub);
    expect(fixture.effects).toEqual([...startup, 'join:global', 'start-actions']);
    expect(window.__messageHubReady).toBe(true);
    expect(window.__messageHub).toBe(hub);
    expect(window.connectionManager).toBe(manager);
  });

  it('waits for the connected event after initialization before joining global', async () => {
    const pending = manager.getHub();
    await setImmediate();
    expect(fixture.effects).toEqual(startup);
    expect(fixture.listeners.size).toBe(2);
    emit('connected');
    await pending;
    expect(fixture.effects.slice(startup.length)).toEqual([
      'state:connected',
      'start-actions',
      'start-audio',
      'start-transcripts',
      'join:global',
      'start-actions',
    ]);
    expect(fixture.listeners.size).toBe(1);
  });

  it.each(['initialization', 'connection-error', 'timeout'])(
    'can retry after %s failure',
    async (failure) => {
      if (failure === 'initialization') {
        fixture.initialize = () => Promise.reject(new Error('initialize failed'));
      }
      if (failure === 'timeout') vi.useFakeTimers();
      const pending = manager.getHub();
      const rejected = expect(pending).rejects.toThrow(
        failure === 'initialization'
          ? 'initialize failed'
          : failure === 'timeout'
            ? 'WebSocket connection timeout'
            : 'WebSocket connection error'
      );
      await setImmediate();
      if (failure === 'connection-error') emit('error');
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(fixture.effects).not.toContain('join:global');
      expect(fixture.effects).not.toContain('start-actions');
      expect(window.__messageHubReady).toBe(false);
      expect(fixture.listeners.size).toBe(1);
      fixture.initialize = async () => {
        fixture.connected = true;
      };
      await manager.getHub();
      expect(fixture.effects.filter((entry) => entry === 'create-hub')).toHaveLength(2);
      expect(fixture.effects.slice(-2)).toEqual(['join:global', 'start-actions']);
    }
  );

  it('stops queues and removes visibility handlers before closing the transport', async () => {
    fixture.connected = true;
    await manager.getHub();
    const removeListener = document.removeEventListener.bind(document);
    const remove = vi.spyOn(document, 'removeEventListener').mockImplementation((...args) => {
      fixture.effects.push(`remove:${args[0]}`);
      removeListener(...args);
    });
    fixture.effects = [];
    fixture.connected = false;
    const notify = vi.fn();
    manager.onceConnected(notify);
    await manager.disconnect();
    expect(fixture.effects).toEqual([
      'stop-actions',
      'stop-audio',
      'stop-transcripts',
      'state:disconnected',
      'remove:visibilitychange',
      'remove:pagehide',
      'close',
    ]);
    expect(remove.mock.calls.map(([event]) => event)).toEqual(['visibilitychange', 'pagehide']);
    expect(manager.getHubIfConnected()).toBeNull();
    expect(Reflect.get(manager, 'stateValidationInterval')).toBeNull();
    fixture.connected = true;
    await manager.getHub();
    emit('connected');
    expect(notify).not.toHaveBeenCalled();
    expect(fixture.effects.filter((entry) => entry === 'create-hub')).toHaveLength(1);
  });
});
