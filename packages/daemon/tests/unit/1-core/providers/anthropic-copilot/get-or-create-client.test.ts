import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from 'vitest';

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

import { AnthropicToCopilotBridgeProvider } from '../../../../../src/lib/providers/anthropic-copilot/index';

describe('createRuntimeClient() — CopilotClient.start() lifecycle', () => {
  let provider: AnthropicToCopilotBridgeProvider;

  beforeEach(() => {
    startCalls.length = 0;
    provider = new AnthropicToCopilotBridgeProvider('/tmp', {});
  });

  it('calls start() on a freshly constructed CopilotClient', async () => {
    const createClient = (
      provider as unknown as {
        createRuntimeClient(token: string | undefined, generation: number): Promise<unknown>;
      }
    ).createRuntimeClient.bind(provider);

    const clientPromise = createClient('gho_test_token', 0);

    expect(startCalls).toHaveLength(1);

    startCalls[0].resolve();
    const client = await clientPromise;

    expect(client).toBeDefined();
  });

  it('stops the client and rejects when a runtime reset lands during start()', async () => {
    const createClient = (
      provider as unknown as {
        createRuntimeClient(token: string | undefined, generation: number): Promise<unknown>;
      }
    ).createRuntimeClient.bind(provider);

    const state = provider as unknown as Record<string, unknown>;
    const generation = state['runtimeGeneration'] as number;
    const clientPromise = createClient('gho_old_token', generation);
    expect(startCalls).toHaveLength(1);

    state['runtimeGeneration'] = generation + 1;
    startCalls[0].resolve();

    await expect(clientPromise).rejects.toThrow('reset during client start');
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
