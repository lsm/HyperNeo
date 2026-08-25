import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type StartRecord = { resolve: () => void; reject: (err: Error) => void };
const startCalls = vi.hoisted(() => [] as StartRecord[]);
const stopCalls = vi.hoisted(() => [] as unknown[]);
const constructOpts = vi.hoisted(() => [] as Record<string, unknown>[]);
const constructFailure = vi.hoisted(() => ({ message: '' }));

vi.mock('@github/copilot-sdk', () => {
  class MockCopilotClient {
    constructor(opts: unknown) {
      constructOpts.push(opts as Record<string, unknown>);
      if (constructFailure.message) {
        throw new Error(constructFailure.message);
      }
    }

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
    constructOpts.length = 0;
    constructFailure.message = '';
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

  it('stops the client and leaves it uncached when logout lands during start()', async () => {
    const getOrCreate = (
      provider as unknown as {
        getOrCreateClient(token?: string): Promise<unknown>;
      }
    ).getOrCreateClient.bind(provider);
    const state = provider as unknown as Record<string, unknown>;
    const version = state['credentialsVersion'] as number;

    const clientPromise = getOrCreate('gho_test_token');
    expect(startCalls).toHaveLength(1);

    state['loggedOut'] = true;
    startCalls[0].resolve();

    await expect(clientPromise).rejects.toThrow('superseded');
    expect(state['clientCache']).toBeUndefined();
    expect(stopCalls).toHaveLength(1);
    expect(state['credentialsVersion']).toBe(version);
  });

  it('rejects a client that finishes starting after a real logout completes', async () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-logout-late-'));
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {}, authDir);
    try {
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        undefined as never
      );
      spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
        undefined as never
      );
      const state = p as unknown as Record<string, unknown>;

      const logoutPromise = p.logout();
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }

      const getOrCreate = (
        p as unknown as {
          getOrCreateClient(token?: string): Promise<unknown>;
        }
      ).getOrCreateClient.bind(p);
      const clientPromise = getOrCreate('gho_test_token');
      expect(startCalls).toHaveLength(1);

      await logoutPromise;
      startCalls[0].resolve();

      await expect(clientPromise).rejects.toThrow('superseded');
      expect(state['clientCache']).toBeUndefined();
      expect(stopCalls).toHaveLength(1);
    } finally {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
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

  it('surfaces CopilotClient construction failure as a clean provider error', async () => {
    constructFailure.message =
      "ResolveMessage: Cannot find package '@github/copilot/sdk' from client.js";

    await expect(
      (provider as unknown as { getOrCreateClient(token?: string): Promise<unknown> })[
        'getOrCreateClient'
      ]('gho_test_token')
    ).rejects.toThrow(
      "Failed to start GitHub Copilot client: ResolveMessage: Cannot find package '@github/copilot/sdk' from client.js"
    );

    expect((provider as unknown as Record<string, unknown>)['clientCache']).toBeUndefined();
    expect(startCalls).toHaveLength(0);
  });

  it('surfaces start() rejection as a clean provider error', async () => {
    const getOrCreate = (
      provider as unknown as {
        getOrCreateClient(token?: string): Promise<unknown>;
      }
    ).getOrCreateClient.bind(provider);

    const p = getOrCreate('gho_test_token');
    expect(startCalls).toHaveLength(1);
    startCalls[0].reject(new Error('CLI server exited with code 1'));

    await expect(p).rejects.toThrow('Failed to start GitHub Copilot client: CLI server exited');
    expect((provider as unknown as Record<string, unknown>)['clientCache']).toBeUndefined();
  });

  it('propagates the clean client-startup error through listRemoteModels()', async () => {
    (provider as unknown as Record<string, unknown>)['tokenCache'] = {
      token: 'gho_test',
      expiresAt: Date.now() + 60_000,
    };
    constructFailure.message = "ResolveMessage: Cannot find package '@github/copilot/sdk'";

    await expect(provider.listRemoteModels()).rejects.toThrow(
      "Failed to start GitHub Copilot client: ResolveMessage: Cannot find package '@github/copilot/sdk'"
    );
  });
});
