import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SDKRateLimitInfo } from '@hyperneo/shared/sdk';
import { AnthropicProvider } from '../../../../src/lib/providers/anthropic-provider';
import {
  resetRateLimitEventReader,
  setRateLimitEventReader,
} from '../../../../src/lib/providers/anthropic-usage-source';

const subscription = {
  type: 'oauth' as const,
  accessToken: 'synthetic-subscription-token',
  refreshToken: 'synthetic-refresh-token',
  expiresAt: Date.now() + 3_600_000,
};

function controlResponse(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: '2026-11-14T02:00:00.000Z' },
      seven_day: { utilization: 54, resets_at: '2026-11-20T02:00:00.000Z' },
      seven_day_opus: { utilization: 3, resets_at: '2026-11-20T02:00:00.000Z' },
      seven_day_sonnet: null,
      model_scoped: [
        { display_name: 'Opus 5.5', utilization: 7, resets_at: '2026-11-20T02:00:00.000Z' },
      ],
      extra_usage: null,
    },
    ...overrides,
  };
}

function mockSdk(getUsage: () => Promise<unknown>) {
  const calls = { usage: 0, interrupted: 0 };
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query: () => ({
      interrupt: async () => {
        calls.interrupted++;
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        calls.usage++;
        return getUsage();
      },
    }),
  }));
  return calls;
}

function provider() {
  const instance = new AnthropicProvider({});
  instance.setCredentials(subscription);
  return instance;
}

beforeEach(() => resetRateLimitEventReader());
afterEach(() => resetRateLimitEventReader());

describe('AnthropicProvider.getUsage', () => {
  it('maps the subscription control response to five windows', async () => {
    const calls = mockSdk(async () => controlResponse());

    const result = await provider().getUsage();

    expect(result).toEqual({
      supported: true,
      provider: 'anthropic',
      windows: [
        { label: '5 hours', used: 12, limit: 100, resetAt: '2026-11-14T02:00:00.000Z' },
        { label: '7 days', used: 54, limit: 100, resetAt: '2026-11-20T02:00:00.000Z' },
        {
          label: '7 days (Opus)',
          used: 3,
          limit: 100,
          resetAt: '2026-11-20T02:00:00.000Z',
        },
        {
          label: 'Opus 5.5',
          used: 7,
          limit: 100,
          resetAt: '2026-11-20T02:00:00.000Z',
        },
      ],
    });
    expect(calls.usage).toBe(1);
  });

  it('answers not_supported for an API key configuration without asking the SDK', async () => {
    const calls = mockSdk(async () => controlResponse());
    const instance = new AnthropicProvider({});
    instance.setCredentials({ type: 'api_key', apiKey: 'synthetic-api-key' });

    expect(await instance.getUsage()).toEqual({
      supported: false,
      provider: 'anthropic',
      reason: 'not_supported',
    });
    expect(calls.usage).toBe(0);
  });

  it('falls back to the latest stored event per window when the control request fails', async () => {
    mockSdk(async () => {
      throw new Error('get_usage unavailable');
    });
    const events: SDKRateLimitInfo[] = [
      {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.87,
        resetsAt: 1_795_000_000,
      },
      { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1_795_006_800 },
      { status: 'allowed', rateLimitType: 'seven_day_opus' },
    ];
    setRateLimitEventReader(async () => events);

    const result = await provider().getUsage();

    expect(result).toEqual({
      supported: true,
      provider: 'anthropic',
      windows: [
        {
          label: '5 hours',
          used: 87,
          limit: 100,
          resetAt: new Date(1_795_000_000_000).toISOString(),
        },
        {
          label: '7 days',
          used: 100,
          limit: 100,
          resetAt: new Date(1_795_006_800_000).toISOString(),
        },
      ],
    });
  });

  it('falls back when the control response changes shape', async () => {
    mockSdk(async () => ({ session: null, subscription_type: null, rate_limits_available: true }));
    setRateLimitEventReader(async () => [
      { status: 'allowed_warning', rateLimitType: 'seven_day_sonnet', utilization: 0.4 },
    ]);

    expect(await provider().getUsage()).toMatchObject({
      supported: true,
      windows: [{ label: '7 days (Sonnet)', used: 40, limit: 100, resetAt: null }],
    });
  });

  it('answers not_supported when there is no control data and no stored event', async () => {
    mockSdk(async () => controlResponse({ rate_limits_available: false, rate_limits: null }));

    expect(await provider().getUsage()).toEqual({
      supported: false,
      provider: 'anthropic',
      reason: 'not_supported',
    });
  });

  it('reports not_supported when the subscription has no credentials', async () => {
    const calls = mockSdk(async () => controlResponse());

    expect(await new AnthropicProvider({}).getUsage()).toEqual({
      supported: false,
      provider: 'anthropic',
      reason: 'not_supported',
    });
    expect(calls.usage).toBe(0);
  });
});
