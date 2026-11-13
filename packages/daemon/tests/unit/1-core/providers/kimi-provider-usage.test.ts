import { describe, expect, mock, test } from 'bun:test';
import { KimiProvider } from '../../../../src/lib/providers/kimi-provider.ts';

const credential = 'synthetic-kimi-key';

function providerWith(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}) {
  const provider = new KimiProvider(env, undefined, fetchImpl);
  provider.setCredentials({ type: 'api_key', apiKey: credential });
  return provider;
}

describe('KimiProvider.getUsage', () => {
  test('requests the Coding usages URL with Bearer authorization and normalizes both usage forms', async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchImpl = mock(async (input: unknown, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return new Response(
        JSON.stringify({
          usage: { used: 12, limit: 100, reset_at: '2026-11-12T20:00:00Z' },
          limits: [
            {
              scope: '7-day quota',
              detail: {
                remaining: 40,
                limit: 200,
                resetTime: '2026-11-19T20:00:00.000Z',
              },
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await providerWith(fetchImpl).getUsage();

    expect(requests).toEqual([
      { url: 'https://api.kimi.com/coding/v1/usages', authorization: `Bearer ${credential}` },
    ]);
    expect(result).toEqual({
      supported: true,
      provider: 'kimi',
      windows: [
        {
          label: 'Weekly limit',
          used: 12,
          limit: 100,
          resetAt: '2026-11-12T20:00:00.000Z',
        },
        {
          label: '7-day quota',
          used: 160,
          limit: 200,
          resetAt: '2026-11-19T20:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  test('labels duration windows, converts epoch seconds, nulls invalid resets, and drops rows without limits', async () => {
    const fetchImpl = mock(
      async () =>
        new Response(
          JSON.stringify({
            limits: [
              {
                window: { duration: 300, timeUnit: 'MINUTES' },
                detail: { used: 5, limit: 50, reset_at: 1_760_000_000 },
              },
              {
                duration: 7,
                timeUnit: 'DAYS',
                used: 70,
                limit: 100,
                reset_time: 'tomorrow',
              },
              { name: 'Incomplete', used: 3 },
            ],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    expect(await providerWith(fetchImpl).getUsage()).toEqual({
      supported: true,
      provider: 'kimi',
      windows: [
        {
          label: '5h limit',
          used: 5,
          limit: 50,
          resetAt: new Date(1_760_000_000_000).toISOString(),
        },
        { label: '7d limit', used: 70, limit: 100, resetAt: null },
      ],
    });
  });

  test('returns not_supported for global Moonshot without making a request', async () => {
    const fetchImpl = mock(async () => new Response('{}')) as unknown as typeof fetch;
    const provider = providerWith(fetchImpl, { KIMI_REGION: 'global' });

    expect(await provider.getUsage()).toEqual({
      supported: false,
      provider: 'kimi',
      reason: 'not_supported',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('fails safely for a missing key, HTTP errors, and malformed payloads', async () => {
    const noKey = new KimiProvider(
      {},
      undefined,
      mock(async () => new Response('{}')) as unknown as typeof fetch
    );
    await expect(noKey.getUsage()).rejects.toThrow('Kimi API key is not configured.');

    const secretBody = `failure ${credential}`;
    const httpFailure = providerWith(
      mock(async () => new Response(secretBody, { status: 503 })) as unknown as typeof fetch
    );
    const httpError = await httpFailure.getUsage().catch((error: unknown) => error);
    expect(httpError).toBeInstanceOf(Error);
    expect((httpError as Error).message).toBe('Kimi usage request failed with status 503.');
    expect((httpError as Error).message).not.toContain(credential);
    expect((httpError as Error).message).not.toContain(secretBody);

    const malformed = providerWith(
      mock(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch
    );
    await expect(malformed.getUsage()).rejects.toThrow('Kimi usage response was malformed.');
  });
});
