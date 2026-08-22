import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AcpConfigOption } from '@hyperneo/shared';
import type { AcpClientOptions } from '../../../../src/lib/acp/acp-client';

const calls: string[] = [];
let clientOptions: AcpClientOptions | undefined;
let lastClient: MockAcpClient | undefined;
let authenticateError: Error | undefined;
let configOptions: AcpConfigOption[] = [];
let clientCanCloseSession = false;
let initializeGate: Promise<void> | null = null;

class MockAcpClient {
  constructor(options: AcpClientOptions) {
    clientOptions = options;
    lastClient = this;
  }

  initialize = mock(async () => {
    calls.push('initialize');
    if (initializeGate) await initializeGate;
    return { protocolVersion: 1 };
  });

  authenticate = mock(async () => {
    calls.push('authenticate');
    if (authenticateError) throw authenticateError;
  });

  createSession = mock(async () => {
    calls.push('createSession');
    return { sessionId: 'session-1', configOptions };
  });

  canCloseSession = mock(() => clientCanCloseSession);

  closeSession = mock(async () => {
    calls.push('closeSession');
  });

  close = mock(async () => {
    calls.push('close');
  });
}

let originalAcpClient: typeof import('../../../../src/lib/acp/acp-client') | undefined;
if (typeof Bun !== 'undefined') {
  originalAcpClient = require('../../../../src/lib/acp/acp-client');
}
mock.module('../../../../src/lib/acp/acp-client', () => ({ AcpClient: MockAcpClient }));

const { disposeAcpSessions, fetchAcpModels } = await import(
  '../../../../src/lib/acp/acp-model-fetcher'
);
const { AcpProvider } = await import('../../../../src/lib/providers/acp-provider');

afterAll(() => {
  if (originalAcpClient) {
    mock.module('../../../../src/lib/acp/acp-client', () => originalAcpClient);
  }
});

describe('fetchAcpModels', () => {
  beforeEach(() => {
    calls.length = 0;
    clientOptions = undefined;
    lastClient = undefined;
    authenticateError = undefined;
    clientCanCloseSession = false;
    initializeGate = null;
    configOptions = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'devin-default',
        options: [{ name: 'Devin Default', value: 'devin-default' }],
      },
    ];
  });

  test('authenticates before creating the discovery session without mutating provider models', async () => {
    const provider = new AcpProvider({}, async () => {});
    provider.setAcpCommand('devin acp');
    provider.setAcpModels([{ id: 'configured-model' }]);

    const models = await fetchAcpModels(provider, { command: 'devin acp', cwd: '/tmp' });

    expect(calls).toEqual(['initialize', 'authenticate', 'createSession', 'close']);
    expect(typeof clientOptions?.processTreeOwner).toBe('function');
    expect(models).toEqual([{ id: 'devin-default', name: 'Devin Default' }]);
    expect(provider.getCachedModels()?.map((model) => model.id)).toEqual(['configured-model']);
  });

  test('does not replace an uncurated negotiated model cache', async () => {
    const provider = new AcpProvider({}, async () => {});
    provider.setAcpCommand('devin acp');
    provider.setConfigOptions([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        category: 'model',
        currentValue: 'old-model',
        options: [{ name: 'Old Model', value: 'old-model' }],
      },
    ]);

    await fetchAcpModels(provider, { command: 'devin acp', cwd: '/tmp' });

    expect(provider.getCachedModels()?.map((model) => model.id)).toEqual(['old-model']);
  });

  test('returns an empty list when the agent has no model option', async () => {
    configOptions = [];

    await expect(
      fetchAcpModels(new AcpProvider(), { command: 'devin acp', cwd: '/tmp' })
    ).resolves.toEqual([]);
    expect(calls.at(-1)).toBe('close');
  });

  test('closes the client when authentication fails', async () => {
    authenticateError = new Error('authentication failed');

    await expect(
      fetchAcpModels(new AcpProvider(), { command: 'devin acp', cwd: '/tmp' })
    ).rejects.toThrow('authentication failed');
    expect(calls).toEqual(['initialize', 'authenticate', 'close']);
  });

  test('uses a restricted discovery environment', async () => {
    const originalSecret = process.env.UNRELATED_PROVIDER_TOKEN;
    process.env.UNRELATED_PROVIDER_TOKEN = 'secret';
    try {
      await fetchAcpModels(new AcpProvider(), { command: 'devin acp', cwd: '/tmp' });
      expect(clientOptions?.env?.UNRELATED_PROVIDER_TOKEN).toBeUndefined();
      expect(clientOptions?.replaceEnv).toBe(true);
    } finally {
      if (originalSecret === undefined) delete process.env.UNRELATED_PROVIDER_TOKEN;
      else process.env.UNRELATED_PROVIDER_TOKEN = originalSecret;
    }
  });

  test('disposes the discovery session before closing when supported', async () => {
    clientCanCloseSession = true;

    await fetchAcpModels(new AcpProvider(), { command: 'devin acp', cwd: '/tmp' });

    expect(calls).toEqual(['initialize', 'authenticate', 'createSession', 'closeSession', 'close']);
  });

  test('disposes persisted sessions through close when supported', async () => {
    clientCanCloseSession = true;

    await disposeAcpSessions('devin acp', ['session-a', 'session-b'], undefined);

    expect(calls).toEqual(['initialize', 'authenticate', 'closeSession', 'closeSession', 'close']);
    expect(lastClient?.closeSession).toHaveBeenCalledWith('session-a');
    expect(lastClient?.closeSession).toHaveBeenCalledWith('session-b');
  });

  test('does not dispose sessions when close is unsupported', async () => {
    await disposeAcpSessions('devin acp', ['session-a'], undefined);

    expect(calls).toEqual(['initialize', 'authenticate', 'close']);
  });

  test('disposes sessions using the ambient environment', async () => {
    clientCanCloseSession = true;

    await disposeAcpSessions('devin acp', ['session-a'], undefined);

    expect(clientOptions?.env).toBeUndefined();
    expect(clientOptions?.replaceEnv).toBeFalsy();
  });

  test('closes the disposal client when its signal aborts', async () => {
    clientCanCloseSession = true;
    let releaseInitialize: () => void;
    initializeGate = new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
    const controller = new AbortController();

    const disposePromise = disposeAcpSessions(
      'devin acp',
      ['session-a'],
      undefined,
      controller.signal
    );
    for (let i = 0; i < 20 && !calls.includes('initialize'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();
    initializeGate = null;
    releaseInitialize!();
    await disposePromise;

    expect(lastClient?.close).toHaveBeenCalled();
  });
});
