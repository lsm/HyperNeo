import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { DeepSeekProvider } from '../../../../src/lib/providers/deepseek-provider';
import {
  recordProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';

describe('DeepSeekProvider', () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });

  it('exposes the current V4 Anthropic-format models', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';
    const fetchImpl = mock(
      async () => new Response('{}', { status: 200 })
    ) as unknown as typeof fetch;
    const provider = new DeepSeekProvider(process.env, fetchImpl);

    expect(await provider.getModels()).toEqual(DeepSeekProvider.MODELS);
    expect(DeepSeekProvider.MODELS.map((model) => model.id)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
    expect(DeepSeekProvider.MODELS.every((model) => model.contextWindow === 1_000_000)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/anthropic/v1/messages');
  });

  it('builds Claude Agent SDK routing through the Anthropic endpoint', () => {
    const provider = new DeepSeekProvider({ DEEPSEEK_API_KEY: 'test-key' });
    const config = provider.buildSdkConfig('deepseek-v4-flash');

    expect(config.isAnthropicCompatible).toBe(true);
    expect(config.envVars.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-key');
    expect(config.envVars.ANTHROPIC_API_KEY).toBe('');
    expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-flash');
    expect(provider.translateModelIdForSdk('deepseek-v4-flash')).toBe('claude-sonnet-4-6[1m]');
    expect(provider.translateModelIdForSdk('deepseek-v4-pro')).toBe('claude-opus-4-6[1m]');
    expect(provider.translateModelIdForSdk('deepseek-pro')).toBe('claude-opus-4-6[1m]');

    const aliasConfig = provider.buildSdkConfig('DEEPSEEK-FLASH');
    expect(aliasConfig.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-flash');
  });

  it('supports stored credentials and rejects missing credentials', async () => {
    const provider = new DeepSeekProvider({});
    expect(provider.isAvailable()).toBe(false);
    expect(await provider.getModels()).toEqual([]);
    expect(() => provider.buildSdkConfig('deepseek-v4-pro')).toThrow(
      'DeepSeek API key not configured'
    );

    provider.setCredentials({ type: 'api_key', apiKey: 'stored-key' });
    expect(provider.isAvailable()).toBe(true);
  });

  it('maps opus to Pro and other Claude tiers to Flash', () => {
    const provider = new DeepSeekProvider({});
    expect(provider.getModelForTier('opus')).toBe('deepseek-v4-pro');
    expect(provider.getModelForTier('sonnet')).toBe('deepseek-v4-flash');
    expect(provider.getModelForTier('haiku')).toBe('deepseek-v4-flash');
    expect(provider.getTitleGenerationModel()).toBe('deepseek-v4-flash');
  });

  it('does not claim colon-tagged Ollama models', () => {
    const provider = new DeepSeekProvider({});
    expect(provider.ownsModel('deepseek-v4-pro')).toBe(true);
    expect(provider.ownsModel('deepseek-pro')).toBe(true);
    expect(provider.ownsModel('deepseek-r1:latest')).toBe(false);
  });

  describe('getAuthStatus', () => {
    beforeEach(() => {
      resetProviderFailureStore();
    });

    afterEach(() => {
      resetProviderFailureStore();
    });

    it('surfaces a recorded credential failure as unauthenticated', async () => {
      const provider = new DeepSeekProvider({ DEEPSEEK_API_KEY: 'invalid-key' });
      recordProviderFailure('deepseek', new Error('DeepSeek API key rejected (HTTP 401)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(false);
      expect(status.errorKind).toBe('credential');
      expect(status.error).toBe('DeepSeek API key rejected (HTTP 401)');
    });

    it('stays authenticated but degraded for a recorded transient failure', async () => {
      const provider = new DeepSeekProvider({ DEEPSEEK_API_KEY: 'test-key' });
      recordProviderFailure('deepseek', new Error('DeepSeek probe failed (HTTP 503)'));

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(true);
      expect(status.errorKind).toBe('transient');
      expect(status.error).toBe('DeepSeek probe failed (HTTP 503)');
    });
  });
});
