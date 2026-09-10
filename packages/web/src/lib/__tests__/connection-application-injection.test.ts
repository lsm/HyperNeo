import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionApplication } from '../connection-application';
import type { ConnectionState } from '../state';
import { ConnectionManager } from '../connection-manager';
import { createDefaultConnectionApplication } from '../connection-application';

vi.mock('../connection-application', () => ({
  createDefaultConnectionApplication: vi.fn(() => makeApplication()),
}));
vi.mock('../signals', () => ({ currentSessionIdSignal: {}, slashCommandsSignal: {} }));

function makeApplication(): ConnectionApplication {
  let state: ConnectionState = 'disconnected';
  return {
    lifecycle: {
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
    },
    createEventEffects: vi.fn<ConnectionApplication['createEventEffects']>(),
    createResumeEffects: vi.fn<ConnectionApplication['createResumeEffects']>(),
    markSessionsRecovering: vi.fn(),
  };
}

describe('ConnectionManager application injection', () => {
  let manager: ConnectionManager | undefined;

  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    await manager?.disconnect();
  });

  it('uses the supplied application without constructing the default', async () => {
    const application = makeApplication();
    manager = new ConnectionManager('ws://example.test', application);
    expect(createDefaultConnectionApplication).not.toHaveBeenCalled();
    application.lifecycle.setState('reconnecting');
    expect(manager.getConnectionState()).toBe('reconnecting');
    manager.simulatePermanentDisconnect();
    expect(application.lifecycle.getState()).toBe('disconnected');
    await manager.disconnect();
    expect(application.lifecycle.stopActions).toHaveBeenCalledOnce();
    expect(application.lifecycle.stopAudio).toHaveBeenCalledOnce();
    expect(application.lifecycle.stopTranscripts).toHaveBeenCalledOnce();
    expect(createDefaultConnectionApplication).not.toHaveBeenCalled();
  });

  it.each(['omitted', 'undefined'])('constructs one default application when %s', (argument) => {
    manager =
      argument === 'omitted'
        ? new ConnectionManager('ws://example.test')
        : new ConnectionManager('ws://example.test', undefined);
    expect(createDefaultConnectionApplication).toHaveBeenCalledOnce();
    const application = vi.mocked(createDefaultConnectionApplication).mock.results[0].value;
    application.lifecycle.setState('failed');
    expect(manager.getConnectionState()).toBe('failed');
    expect(createDefaultConnectionApplication).toHaveBeenCalledOnce();
  });
});
