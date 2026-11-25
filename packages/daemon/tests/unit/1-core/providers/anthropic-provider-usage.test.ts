import { describe, expect, it, mock } from 'bun:test';
import { AnthropicProvider } from '../../../../src/lib/providers/anthropic-provider';

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

function mockSdk(
  getUsage: () => Promise<unknown>,
  inspectEnv?: (env: Record<string, string | undefined>) => void
) {
  const calls = { usage: 0, closed: 0 };
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({
    query: ({ options }: { options: { env: Record<string, string | undefined> } }) => ({
      close: () => {
        calls.closed++;
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        calls.usage++;
        inspectEnv?.(options.env);
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
    expect(calls.closed).toBe(1);
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

  it('uses the configured subscription when an inherited bearer is present', async () => {
    let usesSelectedCredential = false;
    let freshProfile = false;
    mockSdk(
      async () => controlResponse(),
      (env) => {
        usesSelectedCredential =
          !env.ANTHROPIC_AUTH_TOKEN && env.CLAUDE_CODE_OAUTH_TOKEN === subscription.accessToken;
        freshProfile = Boolean(env.CLAUDE_CONFIG_DIR?.includes('hyperneo-usage-'));
      }
    );
    const instance = new AnthropicProvider({
      ANTHROPIC_AUTH_TOKEN: 'synthetic-inherited-bearer',
      CLAUDE_CONFIG_DIR: '/synthetic/inherited-claude-profile',
    });
    instance.setCredentials(subscription);

    const result = await instance.getUsage();

    expect(result.supported).toBe(true);
    expect(usesSelectedCredential).toBe(true);
    expect(freshProfile).toBe(true);
  });

  it('reports unavailable usage when the control request fails', async () => {
    mockSdk(async () => {
      throw new Error('get_usage unavailable');
    });

    expect(await provider().getUsage()).toEqual({
      supported: false,
      provider: 'anthropic',
      reason: 'not_supported',
    });
  });

  it('reports unavailable usage when the control response has no windows', async () => {
    mockSdk(async () => ({ session: null, subscription_type: null, rate_limits_available: true }));

    expect(await provider().getUsage()).toEqual({
      supported: false,
      provider: 'anthropic',
      reason: 'not_supported',
    });
  });

  it('discards a usage response when the credential changed during the request', async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<unknown>();
    mockSdk(async () => {
      started.resolve();
      return response.promise;
    });
    const instance = provider();
    const reading = instance.getUsage();
    await started.promise;
    await instance.logout();
    response.resolve(controlResponse());

    expect(await reading).toEqual({
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
