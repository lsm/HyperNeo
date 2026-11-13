import { describe, expect, mock, test } from 'bun:test';
import type { Provider } from '@hyperneo/shared/provider';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { KimiProvider } from '../../../../src/lib/providers/kimi-provider.ts';
import { createProviderUsageOperations } from '../../../../src/lib/rpc-handlers/family-operations/settings.ts';

const credential = 'synthetic-kimi-key';

function usageOperation(provider: Provider | undefined) {
  return createOperationRegistry(createProviderUsageOperations({ provider: () => provider }));
}

async function invoke(provider: Provider | undefined, caller: OperationCaller = { source: 'rpc' }) {
  return invokeOperation(
    usageOperation(provider),
    'settings.provider.usage',
    { providerId: 'kimi' },
    caller
  );
}

describe('settings.provider.usage', () => {
  test('settings.provider.usage returns Kimi windows through operation.invoke', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            usage: {
              name: '5-hour usage',
              used: 12,
              limit: 100,
              reset_at: '2026-11-12T20:00:00.000Z',
            },
            limits: [
              {
                title: '7-day usage',
                remaining: 40,
                limit: 200,
                resetTime: '2026-11-19T20:00:00.000Z',
              },
            ],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;
    const provider = new KimiProvider({}, undefined, fetchImpl);
    provider.setCredentials({ type: 'api_key', apiKey: credential });

    const result = await invoke(provider);

    expect(result).toEqual({
      kind: 'completed',
      value: {
        supported: true,
        provider: 'kimi',
        windows: [
          {
            label: '5-hour usage',
            used: 12,
            limit: 100,
            resetAt: '2026-11-12T20:00:00.000Z',
          },
          {
            label: '7-day usage',
            used: 160,
            limit: 200,
            resetAt: '2026-11-19T20:00:00.000Z',
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  test('returns not_supported for missing providers and providers without usage support', async () => {
    expect(await invoke(undefined)).toEqual({
      kind: 'completed',
      value: { supported: false, provider: 'kimi', reason: 'not_supported' },
    });
    expect(await invoke({ id: 'kimi' } as Provider)).toEqual({
      kind: 'completed',
      value: { supported: false, provider: 'kimi', reason: 'not_supported' },
    });
  });

  test('uses the default-model caller gate', async () => {
    const provider = { id: 'kimi' } as Provider;
    expect(await invoke(provider, { source: 'mcp', sessionId: 'chat-1' })).toEqual({
      kind: 'completed',
      value: { ok: false, reason: 'neo_only' },
    });
  });
});
