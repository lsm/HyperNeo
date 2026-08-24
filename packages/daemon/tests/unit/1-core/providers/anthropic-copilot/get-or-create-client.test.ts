import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from 'vitest';

type StartRecord = { resolve: () => void; reject: (err: Error) => void };
const startCalls = vi.hoisted(() => [] as StartRecord[]);
const stopCalls = vi.hoisted(() => [] as unknown[]);

vi.mock('@github/copilot-sdk', () => {
  class MockCopilotClient {
    constructor(_opts: unknown) {}

    async start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        startCalls.push({ resolve, reject });
      });
    }

    async stop(): Promise<void> {
      stopCalls.push(this);
    }

    async listModels(): Promise<unknown[]> {
      return [];
    }
  }

  return { CopilotClient: MockCopilotClient };
});

import { AnthropicToCopilotBridgeProvider } from '../../../../../src/lib/providers/anthropic-copilot/index';

describe('getOrCreateClient() — CopilotClient.start() lifecycle', () => {
  let provider: AnthropicToCopilotBridgeProvider;

  beforeEach(() => {
    startCalls.length = 0;
    stopCalls.length = 0;
    provider = new AnthropicToCopilotBridgeProvider('/tmp', {});
  });

  it('calls start() on a freshly constructed CopilotClient', async () => {
    const getOrCreate = (
      provider as unknown as {
        getOrCreateClient(token?: string): Promise<unknown>;
      }
    ).getOrCreateClient.bind(provider);

    const clientPromise = getOrCreate('gho_test_token');

    expect(startCalls).toHaveLength(1);

    startCalls[0].resolve();
    const client = await clientPromise;

    expect(client).toBeDefined();
  });

  it('caches the client after a successful start() so subsequent calls skip start()', async () => {
    const getOrCreate = (
      provider as unknown as {
        getOrCreateClient(token?: string): Promise<unknown>;
      }
    ).getOrCreateClient.bind(provider);

    const p1 = getOrCreate();
    expect(startCalls).toHaveLength(1);
    startCalls[0].resolve();
    const client1 = await p1;

    const client2 = await getOrCreate();
    expect(startCalls).toHaveLength(1);
    expect(client2).toBe(client1);
  });

  it('does NOT cache the client when start() throws, so a retry creates a fresh instance', async () => {
    const getOrCreate = (
      provider as unknown as {
        getOrCreateClient(token?: string): Promise<unknown>;
      }
    ).getOrCreateClient.bind(provider);

    const p1 = getOrCreate();
    expect(startCalls).toHaveLength(1);
    startCalls[0].reject(new Error('CLI not found'));
    await expect(p1).rejects.toThrow('CLI not found');

    expect((provider as unknown as Record<string, unknown>)['clientCache']).toBeUndefined();

    startCalls.length = 0;
    const p2 = getOrCreate();
    expect(startCalls).toHaveLength(1);
    startCalls[0].resolve();
    await expect(p2).resolves.toBeDefined();
  });

  it('stops the client and leaves it uncached when shutdown lands during start()', async () => {
    const getOrCreate = (
      provider as unknown as {
        getOrCreateClient(token?: string): Promise<unknown>;
      }
    ).getOrCreateClient.bind(provider);
    const state = provider as unknown as Record<string, unknown>;

    const clientPromise = getOrCreate('gho_test_token');
    expect(startCalls).toHaveLength(1);

    state['shuttingDown'] = true;
    startCalls[0].resolve();

    await expect(clientPromise).rejects.toThrow('superseded');
    expect(state['clientCache']).toBeUndefined();
    expect(stopCalls).toHaveLength(1);
  });

  it('propagates start() failure through ensureServerStarted()', async () => {
    (provider as unknown as Record<string, unknown>)['tokenCache'] = {
      token: 'gho_test',
      expiresAt: Date.now() + 60_000,
    };

    const p = provider.ensureServerStarted();
    await Promise.resolve();
    await Promise.resolve();
    if (startCalls.length > 0) {
      startCalls[0].reject(new Error('daemon start failed'));
    }

    await expect(p).rejects.toThrow();
  });
});
