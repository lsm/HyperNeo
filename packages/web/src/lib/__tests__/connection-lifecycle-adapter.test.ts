import type { MessageHub } from '@hyperneo/shared';
import type { ConnectionManager } from '../connection-manager';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConnectionLifecycleEffects } from '../connection-lifecycle-adapter';
import { appState, connectionState } from '../state';
import { globalStore } from '../global-store';
import { sessionStore } from '../session-store';
import { currentSessionIdSignal, slashCommandsSignal } from '../signals';

const calls = vi.hoisted(() => ({
  startActions: vi.fn(),
  stopActions: vi.fn(),
  startAudio: vi.fn(),
  stopAudio: vi.fn(),
  startTranscripts: vi.fn(),
  stopTranscripts: vi.fn(),
}));
vi.mock('../state', () => ({ appState: {}, connectionState: { value: 'disconnected' } }));
vi.mock('../global-store', () => ({ globalStore: {} }));
vi.mock('../session-store', () => ({ sessionStore: {} }));
vi.mock('../signals', () => ({ currentSessionIdSignal: {}, slashCommandsSignal: {} }));
vi.mock('../outbound-queue', () => ({
  startAutoFlush: calls.startActions,
  stopAutoFlush: calls.stopActions,
}));
vi.mock('../voice/voice-audio-outbox', () => ({
  startVoiceAudioOutboxFlush: calls.startAudio,
  stopVoiceAudioOutboxFlush: calls.stopAudio,
}));
vi.mock('../voice/voice-transcript-outbox', () => ({
  startVoiceTranscriptOutboxFlush: calls.startTranscripts,
  stopVoiceTranscriptOutboxFlush: calls.stopTranscripts,
}));

const hub = {} as MessageHub;
const manager = {} as ConnectionManager;

describe('default connection lifecycle application adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does not perform application effects during construction', () => {
    const effects = createDefaultConnectionLifecycleEffects();
    for (const callback of Object.values(calls)) expect(callback).not.toHaveBeenCalled();
    connectionState.value = 'connecting';
    expect(effects.getState()).toBe('connecting');
    effects.setState('connected');
    expect(connectionState.value).toBe('connected');
    connectionState.value = 'failed';
    expect(effects.getState()).toBe('failed');
  });

  it.each(Object.keys(calls) as Array<keyof typeof calls>)('delegates only %s', (name) => {
    const effects = createDefaultConnectionLifecycleEffects();
    effects[name]();
    for (const [key, callback] of Object.entries(calls)) {
      expect(callback).toHaveBeenCalledTimes(key === name ? 1 : 0);
    }
  });

  it('publishes current application references and resets readiness on each exposure', () => {
    vi.stubGlobal('window', {});
    const effects = createDefaultConnectionLifecycleEffects();
    effects.exposeHub(hub, manager);
    expect(window).toEqual({
      __messageHub: hub,
      connectionManager: manager,
      __messageHubReady: false,
      appState,
      globalStore,
      sessionStore,
      currentSessionIdSignal,
      slashCommandsSignal,
    });
    effects.markHubReady();
    expect(window.__messageHubReady).toBe(true);
    const replacement = {} as MessageHub;
    effects.exposeHub(replacement, manager);
    expect(window.__messageHub).toBe(replacement);
    expect(window.__messageHubReady).toBe(false);
  });

  it('checks for a current global hub before marking readiness', () => {
    vi.stubGlobal('window', {});
    const effects = createDefaultConnectionLifecycleEffects();
    effects.markHubReady();
    expect(window.__messageHubReady).toBeUndefined();
    effects.exposeHub(hub, manager);
    delete window.__messageHub;
    effects.markHubReady();
    expect(window.__messageHubReady).toBe(false);
  });

  it('can expose and mark readiness without a browser', () => {
    const effects = createDefaultConnectionLifecycleEffects();
    vi.stubGlobal('window', undefined);
    expect(() => effects.exposeHub(hub, manager)).not.toThrow();
    expect(() => effects.markHubReady()).not.toThrow();
  });
});
