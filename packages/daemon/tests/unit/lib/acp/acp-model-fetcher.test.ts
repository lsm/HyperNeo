import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { AcpClientOptions } from '../../../../src/lib/acp/acp-client';

const calls: string[] = [];

class MockAcpClient {
  constructor(_options: AcpClientOptions) {}

  initialize = mock(async () => {
    calls.push('initialize');
    return { protocolVersion: 1 };
  });

  authenticate = mock(async () => {
    calls.push('authenticate');
  });

  createSession = mock(async () => {
    calls.push('createSession');
    return {
      sessionId: 'session-1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select' as const,
          category: 'model',
          currentValue: 'devin-default',
          options: [{ name: 'Devin Default', value: 'devin-default' }],
        },
      ],
    };
  });

  close = mock(() => {
    calls.push('close');
  });
}

let originalAcpClient: typeof import('../../../../src/lib/acp/acp-client') | undefined;
if (typeof Bun !== 'undefined') {
  originalAcpClient = require('../../../../src/lib/acp/acp-client');
}
mock.module('../../../../src/lib/acp/acp-client', () => ({ AcpClient: MockAcpClient }));

const { fetchAcpModels } = await import('../../../../src/lib/acp/acp-model-fetcher');
const { AcpProvider } = await import('../../../../src/lib/providers/acp-provider');

afterAll(() => {
  if (originalAcpClient) {
    mock.module('../../../../src/lib/acp/acp-client', () => originalAcpClient);
  }
});

describe('fetchAcpModels', () => {
  test('authenticates before creating the discovery session without mutating provider models', async () => {
    const provider = new AcpProvider({}, async () => {});
    provider.setAcpModels([{ id: 'configured-model' }]);

    const models = await fetchAcpModels(provider, { command: 'devin acp', cwd: '/tmp' });

    expect(calls).toEqual(['initialize', 'authenticate', 'createSession', 'close']);
    expect(models).toEqual([{ id: 'devin-default', name: 'Devin Default' }]);
    expect(provider.getCachedModels()?.map((model) => model.id)).toEqual(['configured-model']);
  });
});
