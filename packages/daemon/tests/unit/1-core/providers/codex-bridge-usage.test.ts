import { describe, expect, test } from 'bun:test';
import type { CodexAppServer } from '../../../../src/lib/drivers/codex-app-server.ts';
import { AnthropicToCodexBridgeProvider } from '../../../../src/lib/providers/anthropic-to-codex-bridge-provider.ts';

const reset5h = '2026-11-13T20:00:00.000Z';
const reset7d = '2026-11-20T20:00:00.000Z';
const epoch5h = Date.parse(reset5h) / 1000;
const epoch7d = Date.parse(reset7d) / 1000;

const fixture = (accountId: string | null) => ({
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    limitName: 'Codex',
    normalModelSlug: null,
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: epoch5h },
    secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: epoch7d },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: 'Codex',
      normalModelSlug: null,
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: epoch5h },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: epoch7d },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    },
    codex_other: {
      limitId: 'codex_other',
      limitName: 'Codex Spark',
      normalModelSlug: null,
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: epoch5h },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: null,
  accountId,
  rateLimitUpsell: null,
});

function serverWith(result: unknown) {
  const calls: { method: string; params: unknown }[] = [];
  const server: Pick<CodexAppServer, 'call' | 'close'> = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return result;
    },
    close: () => {},
  };
  return { server, calls };
}

function provider(server: Pick<CodexAppServer, 'call' | 'close'>, accountId = 'acct-1') {
  const bridge = new AnthropicToCodexBridgeProvider(
    {},
    undefined,
    '/synthetic/codex-home',
    undefined,
    async () => server
  );
  bridge.setCredentials({
    type: 'oauth',
    accessToken: 'synthetic-token',
    raw: { accountId },
  });
  return bridge;
}

describe('AnthropicToCodexBridgeProvider.getUsage', () => {
  test('reads account/rateLimits once and maps windows with limitName-prefixed buckets', async () => {
    const { server, calls } = serverWith(fixture('acct-1'));
    const result = await provider(server).getUsage();
    expect(calls).toEqual([{ method: 'account/rateLimits/read', params: {} }]);
    expect(result).toEqual({
      supported: true,
      provider: 'anthropic-codex',
      windows: [
        { label: '5 hours', used: 42, limit: 100, resetAt: reset5h },
        { label: '7 days', used: 10, limit: 100, resetAt: reset7d },
        { label: 'Codex 5 hours', used: 42, limit: 100, resetAt: reset5h },
        { label: 'Codex 7 days', used: 10, limit: 100, resetAt: reset7d },
        { label: 'Codex Spark 5 hours', used: 1, limit: 100, resetAt: reset5h },
      ],
    });
  });

  test('returns not_supported when the app-server account differs from the bridge account', async () => {
    const { server } = serverWith(fixture('cli-other-account'));
    expect(await provider(server, 'acct-1').getUsage()).toEqual({
      supported: false,
      provider: 'anthropic-codex',
      reason: 'not_supported',
    });
  });

  test('returns not_supported when the bridge has no ChatGPT account id', async () => {
    const { server } = serverWith(fixture('acct-1'));
    const bridge = new AnthropicToCodexBridgeProvider(
      {},
      undefined,
      '/synthetic/codex-home',
      undefined,
      async () => server
    );
    bridge.setCredentials({ type: 'api_key', apiKey: 'synthetic-key' });
    expect(await bridge.getUsage()).toEqual({
      supported: false,
      provider: 'anthropic-codex',
      reason: 'not_supported',
    });
  });

  test('a failed request throws without credentials or response details', async () => {
    const secret = 'synthetic-token';
    const server: Pick<CodexAppServer, 'call' | 'close'> = {
      call: async () => {
        throw new Error(`app-server rejected the read for ${secret}`);
      },
      close: () => {},
    };
    await expect(provider(server).getUsage()).rejects.toThrow(/usage request failed/);
    await expect(provider(server).getUsage()).rejects.not.toThrow(new RegExp(secret));
  });
});
