import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager } from '../connection-manager';

const fixture = vi.hoisted(() => ({
  effects: [] as string[],
  failure: '',
  activeSpace: 'space-1' as string | null,
  ready: true,
  refresh: (_name: string): Promise<void> => Promise.resolve(),
}));
vi.mock('../state', () => ({
  appState: { refreshAll: () => fixture.refresh('app') },
  connectionState: {
    set value(state: string) {
      fixture.effects.push(`state:${state}`);
    },
  },
  reconnectAttemptCount: { value: 0 },
}));
vi.mock('../global-store', () => ({ globalStore: { refresh: () => fixture.refresh('global') } }));
vi.mock('../session-store', () => ({
  sessionStore: {},
  markAllSessionStoresRecovering: () => fixture.effects.push('mark-recovering'),
  refreshAllSessionStores: () => fixture.refresh('sessions'),
}));
vi.mock('../space-store', () => ({
  spaceStore: {
    spaceId: {
      get value() {
        return fixture.activeSpace;
      },
    },
    refresh: () => fixture.refresh('space'),
  },
}));
vi.mock('../space-agent-store', () => ({
  spaceAgentStore: { recover: () => fixture.refresh('agents') },
}));
vi.mock('../signals', () => ({ currentSessionIdSignal: {}, slashCommandsSignal: {} }));
vi.mock('../outbound-queue', () => ({ startAutoFlush: () => {}, stopAutoFlush: () => {} }));
vi.mock('../voice/voice-audio-outbox', () => ({
  startVoiceAudioOutboxFlush: () => {},
  stopVoiceAudioOutboxFlush: () => {},
}));
vi.mock('../voice/voice-transcript-outbox', () => ({
  startVoiceTranscriptOutboxFlush: () => {},
  stopVoiceTranscriptOutboxFlush: () => {},
}));

const refreshes = [
  'refresh:sessions',
  'refresh:app',
  'refresh:global',
  'refresh:space',
  'refresh:agents',
];

describe('real ConnectionManager resume recovery', () => {
  let manager: ConnectionManager;
  const runResume = () =>
    (Reflect.get(manager, 'validateConnectionOnResume') as () => Promise<void>).call(manager);

  beforeEach(() => {
    fixture.effects = [];
    fixture.failure = '';
    fixture.activeSpace = 'space-1';
    fixture.ready = true;
    fixture.refresh = async (name) => {
      fixture.effects.push(`refresh:${name}`);
      if (fixture.failure === `refresh:${name}`) throw new Error(name);
    };
    manager = new ConnectionManager('ws://example.test');
    manager.onceConnected(() => fixture.effects.push('notify'));
    Reflect.set(manager, 'messageHub', {
      request: async (method: string, data: object, options: object) => {
        expect([method, data, options]).toEqual(['system.health', {}, { timeout: 3000 }]);
        fixture.effects.push('health');
        if (fixture.failure === 'health') throw new Error('health');
      },
      joinChannel: async (channel: string) => {
        fixture.effects.push(`join:${channel}`);
        if (fixture.failure === `join:${channel}`) throw new Error(channel);
      },
    });
    Reflect.set(manager, 'transport', {
      isReady: () => fixture.ready,
      forceReconnect: () => fixture.effects.push('force-reconnect'),
      close: () => {},
    });
  });

  afterEach(async () => {
    await manager.disconnect();
    vi.restoreAllMocks();
  });

  it('restores channels before launching all refreshes and waits for the last refresh', async () => {
    const releases: Array<() => void> = [];
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    fixture.refresh = (name) => {
      fixture.effects.push(`refresh:${name}`);
      return new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 5) allStarted();
      });
    };
    const pending = runResume();
    expect(Reflect.get(manager, '_isResuming')).toBe(true);
    await started;
    expect(fixture.effects).toEqual([
      'mark-recovering',
      'health',
      'join:global',
      'join:space:space-1',
      ...refreshes,
    ]);
    for (const release of releases.slice(0, 4)) release();
    await Promise.resolve();
    expect(Reflect.get(manager, '_isResuming')).toBe(true);
    expect(fixture.effects).not.toContain('notify');
    releases[4]();
    await pending;
    expect(fixture.effects.slice(-2)).toEqual(['state:connected', 'notify']);
    expect(Reflect.get(manager, '_isResuming')).toBe(false);
  });

  it.each([
    'health',
    'join:global',
    'join:space:space-1',
    'refresh:app',
  ])('reconnects on %s failure and still finalizes as connected when transport remains ready', async (failure) => {
    fixture.failure = failure;
    await runResume();
    const beforeFailure = ['mark-recovering', 'health'];
    if (failure !== 'health') beforeFailure.push('join:global');
    if (failure === 'join:space:space-1' || failure === 'refresh:app')
      beforeFailure.push('join:space:space-1');
    if (failure === 'refresh:app') beforeFailure.push(...refreshes);
    expect(fixture.effects).toEqual([
      ...beforeFailure,
      'force-reconnect',
      'state:connected',
      'notify',
    ]);
    expect(Reflect.get(manager, '_isResuming')).toBe(false);
  });

  it('omits only the space-channel join when no space is active', async () => {
    fixture.activeSpace = null;
    await runResume();
    expect(fixture.effects).toEqual([
      'mark-recovering',
      'health',
      'join:global',
      ...refreshes,
      'state:connected',
      'notify',
    ]);
  });

  it('clears the resume flag without announcing connected when transport is not ready', async () => {
    fixture.ready = false;
    fixture.failure = 'health';
    await runResume();
    expect(fixture.effects).toEqual(['mark-recovering', 'health', 'force-reconnect']);
    expect(Reflect.get(manager, '_isResuming')).toBe(false);
  });

  it('uses reconnect without health checks when resources are absent', async () => {
    Reflect.set(manager, 'messageHub', null);
    Reflect.set(manager, 'transport', null);
    vi.spyOn(manager, 'reconnect').mockImplementation(async () => {
      fixture.effects.push('reconnect');
    });
    await runResume();
    expect(fixture.effects).toEqual(['mark-recovering', 'reconnect']);
    expect(Reflect.get(manager, '_isResuming')).toBe(false);
  });
});
