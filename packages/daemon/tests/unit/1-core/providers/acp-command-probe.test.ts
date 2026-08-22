import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AcpClientOptions } from '../../../../src/lib/acp/acp-client';

const calls: string[] = [];
let clientOptions: AcpClientOptions | undefined;
let initializeError: Error | undefined;

class MockAcpClient {
  constructor(options: AcpClientOptions) {
    clientOptions = options;
  }

  initialize = mock(async () => {
    calls.push('initialize');
    if (initializeError) throw initializeError;
    return { protocolVersion: 1 };
  });

  authenticate = mock(async () => {
    calls.push('authenticate');
  });

  close = mock(() => {
    calls.push('close');
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        calls.push('close-done');
        resolve();
      }, 5);
    });
  });
}

let originalAcpClient: typeof import('../../../../src/lib/acp/acp-client') | undefined;
if (typeof Bun !== 'undefined') {
  originalAcpClient = require('../../../../src/lib/acp/acp-client');
}
mock.module('../../../../src/lib/acp/acp-client', () => ({ AcpClient: MockAcpClient }));

const { defaultAcpCommandProbe } = await import('../../../../src/lib/providers/acp-provider');

describe('defaultAcpCommandProbe', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    calls.length = 0;
    clientOptions = undefined;
    initializeError = undefined;
  });

  afterAll(() => {
    process.env = originalEnv;
    if (originalAcpClient) {
      mock.module('../../../../src/lib/acp/acp-client', () => originalAcpClient);
    }
  });

  test('parses quoted command paths and arguments with a sanitized environment', async () => {
    process.env = {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      ANTHROPIC_AUTH_TOKEN: 'secret',
    };

    await defaultAcpCommandProbe('"/Applications/Devin CLI/devin" acp');

    expect(clientOptions?.command).toBe('/Applications/Devin CLI/devin');
    expect(clientOptions?.args).toEqual(['acp']);
    expect(clientOptions?.env).toEqual({ PATH: '/safe/bin', HOME: '/safe/home' });
    expect(clientOptions?.replaceEnv).toBe(true);
  });

  test('completes the initialize handshake without authenticating before resolving', async () => {
    await defaultAcpCommandProbe('devin acp');

    expect(calls).toEqual(['initialize', 'close', 'close-done']);
  });

  test('waits for client shutdown to finish before resolving', async () => {
    let probeSettled = false;
    const pending = defaultAcpCommandProbe('devin acp').then(
      () => {
        probeSettled = true;
      },
      () => {
        probeSettled = true;
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls).toContain('close');
    expect(probeSettled).toBe(false);

    await pending;
    expect(probeSettled).toBe(true);
    expect(calls).toEqual(['initialize', 'close', 'close-done']);
  });

  test('bounds each handshake request by the probe timeout', async () => {
    await defaultAcpCommandProbe('devin acp', 2500);

    expect(clientOptions?.requestTimeoutMs).toBe(2500);
  });

  test('rejects when initialization fails and still closes the client', async () => {
    initializeError = new Error('agent exited before initialize');

    await expect(defaultAcpCommandProbe('false acp')).rejects.toThrow(
      'agent exited before initialize'
    );
    expect(calls).toEqual(['initialize', 'close', 'close-done']);
  });
});
