import { MessageHub } from '@hyperneo/shared';
import { setImmediate } from 'node:timers/promises';
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
  let hub: MessageHub;
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
    hub = new MessageHub();
    vi.spyOn(hub, 'isConnected').mockReturnValue(true);
    vi.spyOn(hub, 'request').mockImplementation(async (method, data, options) => {
      if (method === 'channel.join') {
        const channel = (data as { channel: string }).channel;
        fixture.effects.push(`join:${channel}`);
        if (fixture.failure === `join:${channel}`) throw new Error(channel);
        return;
      }
      expect([method, data, options]).toEqual(['system.health', {}, { timeout: 3000 }]);
      fixture.effects.push('health');
      if (fixture.failure === 'health') throw new Error('health');
    });
    Reflect.set(manager, 'messageHub', hub);
    Reflect.set(manager, 'transport', {
      isReady: () => fixture.ready,
      forceReconnect: () => {
        fixture.effects.push('force-reconnect');
        fixture.ready = false;
      },
      close: () => {},
    });
  });

  afterEach(async () => {
    await manager.disconnect();
    vi.restoreAllMocks();
  });

  it.each([0, 1, 2, 3, 4])('waits for refresh %s after all others complete', async (held) => {
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
    let settled = false;
    const pending = runResume().then(() => {
      settled = true;
    });
    expect(Reflect.get(manager, '_isResuming')).toBe(true);
    await started;
    expect(fixture.effects).toEqual([
      'mark-recovering',
      'health',
      'join:global',
      'join:space:space-1',
      ...refreshes,
    ]);
    for (const [index, release] of releases.entries()) if (index !== held) release();
    await setImmediate();
    expect(settled).toBe(false);
    expect(Reflect.get(manager, '_isResuming')).toBe(true);
    expect(fixture.effects).not.toContain('notify');
    releases[held]();
    await pending;
    expect(fixture.effects.slice(-2)).toEqual(['state:connected', 'notify']);
    expect(Reflect.get(manager, '_isResuming')).toBe(false);
  });

  it.each(['health', 'refresh:app', 'refresh:global'])(
    'reconnects on %s failure without announcing connected',
    async (failure) => {
      fixture.failure = failure;
      await runResume();
      const beforeFailure = ['mark-recovering', 'health'];
      if (failure !== 'health')
        beforeFailure.push('join:global', 'join:space:space-1', ...refreshes);
      expect(fixture.effects).toEqual([...beforeFailure, 'force-reconnect']);
      expect(fixture.ready).toBe(false);
      expect(Reflect.get(manager, '_isResuming')).toBe(false);
    }
  );

  it.each(['global', 'space:space-1'])(
    'continues recovery after %s join retries are exhausted',
    async (channel) => {
      vi.useFakeTimers();
      fixture.failure = `join:${channel}`;
      try {
        const pending = runResume();
        await vi.runAllTimersAsync();
        await pending;
        expect(fixture.effects.filter((effect) => effect === `join:${channel}`)).toHaveLength(3);
        expect(fixture.effects.slice(-7)).toEqual([...refreshes, 'state:connected', 'notify']);
        expect(fixture.effects).not.toContain('force-reconnect');
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('awaits each channel join before starting the next stage', async () => {
    const releases: Array<() => void> = [];
    vi.spyOn(hub, 'joinChannel').mockImplementation((channel) => {
      fixture.effects.push(`join:${channel}`);
      return new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    });
    const pending = runResume();
    await setImmediate();
    expect(fixture.effects).toEqual(['mark-recovering', 'health', 'join:global']);
    fixture.activeSpace = 'space-2';
    releases[0]();
    await setImmediate();
    expect(fixture.effects).toEqual([
      'mark-recovering',
      'health',
      'join:global',
      'join:space:space-2',
    ]);
    releases[1]();
    await pending;
    expect(fixture.effects.slice(-7)).toEqual([...refreshes, 'state:connected', 'notify']);
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
    const refresh = fixture.refresh;
    fixture.refresh = async (name) => {
      await refresh(name);
      fixture.ready = false;
    };
    await runResume();
    expect(fixture.effects).toEqual([
      'mark-recovering',
      'health',
      'join:global',
      'join:space:space-1',
      ...refreshes,
    ]);
    expect(Reflect.get(manager, '_isResuming')).toBe(false);
  });

  it.each(['messageHub', 'transport', 'both'])(
    'uses reconnect when %s is absent',
    async (missing) => {
      if (missing !== 'transport') Reflect.set(manager, 'messageHub', null);
      if (missing !== 'messageHub') Reflect.set(manager, 'transport', null);
      vi.spyOn(manager, 'reconnect').mockImplementation(async () => {
        fixture.effects.push('reconnect');
        if (missing === 'messageHub') {
          const transport = Reflect.get(manager, 'transport') as { forceReconnect(): void };
          transport.forceReconnect();
        } else {
          fixture.ready = true;
          Reflect.set(manager, 'transport', {
            isReady: () => fixture.ready,
            close: () => {},
          });
        }
      });
      await runResume();
      expect(fixture.effects).toEqual(
        missing === 'messageHub'
          ? ['mark-recovering', 'reconnect', 'force-reconnect']
          : ['mark-recovering', 'reconnect', 'state:connected', 'notify']
      );
      expect(Reflect.get(manager, '_isResuming')).toBe(false);
    }
  );
});
