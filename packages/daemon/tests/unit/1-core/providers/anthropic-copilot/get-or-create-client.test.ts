/**
 * Unit tests for AnthropicToCopilotBridgeProvider — getOrCreateClient()
 *
 * Verifies that:
 *  - CopilotClient.start() is called after construction (fixes the "client not connected" warning)
 *  - When start() fails, clientCache is NOT populated so the next call retries with a fresh instance
 *  - When start() succeeds, the client is cached and reused on subsequent calls
 *
 * Uses mock.module('@github/copilot-sdk') to inject a controllable CopilotClient stub.
 * All other copilot provider tests import the SDK only as `import type`, so this mock
 * does not affect their runtime behaviour.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from 'vitest';

// Track start() calls so each test can inspect them independently.
// vi.hoisted so the (hoisted) vi.mock factory can reference it.
type StartRecord = { resolve: () => void; reject: (err: Error) => void };
const startCalls = vi.hoisted(() => [] as StartRecord[]);

vi.mock('@github/copilot-sdk', () => {
  class MockCopilotClient {
    constructor(_opts: unknown) {}

    async start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        startCalls.push({ resolve, reject });
      });
    }

    async stop(): Promise<void> {}

    async listModels(): Promise<unknown[]> {
      return [];
    }
  }

  return { CopilotClient: MockCopilotClient };
});

// Import AFTER mock.module so the provider picks up the mocked CopilotClient.
import { AnthropicToCopilotBridgeProvider } from '../../../../../src/lib/providers/anthropic-copilot/index';

describe('getOrCreateClient() — CopilotClient.start() lifecycle', () => {
  let provider: AnthropicToCopilotBridgeProvider;

  beforeEach(() => {
    startCalls.length = 0;
    provider = new AnthropicToCopilotBridgeProvider('/tmp', {});
  });

  it('calls start() on a freshly constructed CopilotClient', async () => {
    // Call the private method directly through the type escape.
    const getOrCreate = (
      provider as unknown as {
        getOrCreateClient(token?: string): Promise<unknown>;
      }
    ).getOrCreateClient.bind(provider);

    // Kick off getOrCreateClient — it will hang until we resolve start()
    const clientPromise = getOrCreate('gho_test_token');

    // start() must have been called exactly once by now
    expect(startCalls).toHaveLength(1);

    // Resolve start() to allow the client to be created
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

    // First call — start() is invoked
    const p1 = getOrCreate();
    expect(startCalls).toHaveLength(1);
    startCalls[0].resolve();
    const client1 = await p1;

    // Second call — must return the cached client without calling start() again
    const client2 = await getOrCreate();
    expect(startCalls).toHaveLength(1); // still only one start() call
    expect(client2).toBe(client1);
  });

  it('does NOT cache the client when start() throws, so a retry creates a fresh instance', async () => {
    const getOrCreate = (
      provider as unknown as {
        getOrCreateClient(token?: string): Promise<unknown>;
      }
    ).getOrCreateClient.bind(provider);

    // First call — start() rejects
    const p1 = getOrCreate();
    expect(startCalls).toHaveLength(1);
    startCalls[0].reject(new Error('CLI not found'));
    await expect(p1).rejects.toThrow('CLI not found');

    // clientCache must still be undefined
    expect((provider as unknown as Record<string, unknown>)['clientCache']).toBeUndefined();

    // Second call — a brand-new CopilotClient is constructed and start() is called again
    startCalls.length = 0;
    const p2 = getOrCreate();
    expect(startCalls).toHaveLength(1);
    startCalls[0].resolve();
    await expect(p2).resolves.toBeDefined();
  });

  it('propagates start() failure through ensureServerStarted()', async () => {
    // Wire up a real token so the provider proceeds past isAvailable() check.
    (provider as unknown as Record<string, unknown>)['tokenCache'] = {
      token: 'gho_test',
      expiresAt: Date.now() + 60_000,
    };

    // ensureServerStarted() → createServer() → getOrCreateClient() → start() → rejects
    const p = provider.ensureServerStarted();
    // Give the async chain a tick to reach start()
    await Promise.resolve();
    await Promise.resolve();
    if (startCalls.length > 0) {
      startCalls[0].reject(new Error('daemon start failed'));
    }

    await expect(p).rejects.toThrow();
  });
});
