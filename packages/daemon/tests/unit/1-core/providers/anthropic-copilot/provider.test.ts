/**
 * Unit tests for AnthropicToCopilotBridgeProvider
 *
 * Tests cover:
 * - Provider properties (id, capabilities, ownsModel, getModelForTier)
 * - Availability checks (credential discovery chain)
 * - Credential sources: loadStoredGitHubToken, tryGhHostsToken
 * - logout() removes stored credentials and invalidates the token cache
 * - startOAuthFlow() returns ProviderOAuthFlowData with correct shape
 * - buildSdkConfig env-var shape (requires pre-warmed serverCache)
 * - getModels() pre-warms the embedded server
 * - shutdown() stops the embedded server and CopilotClient
 * - ensureServerStarted() retry-after-failure
 *
 * NOTE: All tests that touch credential storage use spies on private methods rather
 * than real file I/O. This avoids interference from `mock.module('node:fs/promises', ...)`
 * calls in other test files (e.g. mcp-handlers.test.ts) that leak across the test run.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { AnthropicToCopilotBridgeProvider } from '../../../../../src/lib/providers/anthropic-copilot/index';
import {
  initializeProviders,
  resetProviderFactory,
  waitForOptionalProviderRegistration,
} from '../../../../../src/lib/providers/factory';
import {
  getProviderRegistry,
  resetProviderRegistry,
} from '../../../../../src/lib/providers/registry';

// ---------------------------------------------------------------------------
// AnthropicToCopilotBridgeProvider — unit tests
// ---------------------------------------------------------------------------

describe('AnthropicToCopilotBridgeProvider', () => {
  let provider: AnthropicToCopilotBridgeProvider;

  beforeEach(() => {
    provider = new AnthropicToCopilotBridgeProvider('/tmp', {});
  });

  describe('basic properties', () => {
    it('has correct id', () => {
      expect(provider.id).toBe('anthropic-copilot');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('GitHub Copilot (Anthropic API)');
    });

    it('has streaming=true', () => {
      expect(provider.capabilities.streaming).toBe(true);
    });

    it('has functionCalling=true (tool-use bridge via ConversationManager)', () => {
      expect(provider.capabilities.functionCalling).toBe(true);
    });

    it('has vision=false', () => {
      expect(provider.capabilities.vision).toBe(false);
    });

    it('has extendedThinking=false', () => {
      expect(provider.capabilities.extendedThinking).toBe(false);
    });
  });

  describe('ownsModel', () => {
    it('owns all copilot-anthropic-* aliases', () => {
      expect(provider.ownsModel('copilot-anthropic-opus')).toBe(true);
      expect(provider.ownsModel('copilot-anthropic-sonnet')).toBe(true);
      expect(provider.ownsModel('copilot-anthropic-codex')).toBe(true);
      expect(provider.ownsModel('copilot-anthropic-gpt-5.4')).toBe(true);
      expect(provider.ownsModel('copilot-anthropic-gpt-5.5')).toBe(true);
      expect(provider.ownsModel('copilot-anthropic-gemini')).toBe(true);
      expect(provider.ownsModel('copilot-anthropic-mini')).toBe(true);
    });

    it('owns all bare model IDs in the model list', () => {
      // No legacy CLI provider collision — bare IDs are owned by this provider
      expect(provider.ownsModel('claude-opus-4.6')).toBe(true);
      expect(provider.ownsModel('claude-sonnet-4.6')).toBe(true);
      expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
      expect(provider.ownsModel('gpt-5.4')).toBe(true);
      expect(provider.ownsModel('gpt-5.5')).toBe(true);
      expect(provider.ownsModel('gpt-5-mini')).toBe(true);
    });

    it('owns gemini-3.1-pro-preview bare ID', () => {
      expect(provider.ownsModel('gemini-3.1-pro-preview')).toBe(true);
    });

    it('does not own unknown models', () => {
      expect(provider.ownsModel('copilot-sdk-sonnet')).toBe(false);
      expect(provider.ownsModel('llama-3')).toBe(false);
    });
  });

  describe('getModelForTier', () => {
    it('maps opus tier to claude-opus-4.6 (no dynamic cache)', () => {
      expect(provider.getModelForTier('opus')).toBe('claude-opus-4.6');
    });

    it('maps sonnet tier to claude-sonnet-4.6 (no dynamic cache)', () => {
      expect(provider.getModelForTier('sonnet')).toBe('claude-sonnet-4.6');
    });

    it('maps haiku tier to gpt-5-mini (no dynamic cache)', () => {
      expect(provider.getModelForTier('haiku')).toBe('gpt-5-mini');
    });

    it('maps default tier to claude-sonnet-4.6 (no dynamic cache)', () => {
      expect(provider.getModelForTier('default')).toBe('claude-sonnet-4.6');
    });

    it('returns static ID when dynamic cache contains a matching model', () => {
      // Inject dynamic cache that includes the static haiku ID
      (provider as unknown as Record<string, unknown>)['dynamicModelsCache'] = [
        {
          id: 'gpt-5-mini',
          name: 'GPT-5 Mini (Copilot)',
          alias: 'copilot-anthropic-mini',
          family: 'gpt',
          provider: 'anthropic-copilot',
          contextWindow: 128000,
          description: 'test',
          releaseDate: '2025-01-01',
          available: true,
        },
      ];
      expect(provider.getModelForTier('haiku')).toBe('gpt-5-mini');
    });

    it('returns an available model from dynamic cache when static ID is not present', () => {
      // Dynamic cache has gpt-4o-mini (fits haiku keywords) but NOT gpt-5-mini
      (provider as unknown as Record<string, unknown>)['dynamicModelsCache'] = [
        {
          id: 'gpt-4o',
          name: 'GPT-4o (Copilot)',
          alias: 'copilot-gpt-4o',
          family: 'gpt',
          provider: 'anthropic-copilot',
          contextWindow: 128000,
          description: 'test',
          releaseDate: '2025-01-01',
          available: true,
        },
        {
          id: 'gpt-4o-mini',
          name: 'GPT-4o Mini (Copilot)',
          alias: 'copilot-gpt-4o-mini',
          family: 'gpt',
          provider: 'anthropic-copilot',
          contextWindow: 128000,
          description: 'test',
          releaseDate: '2025-01-01',
          available: true,
        },
      ];
      // haiku tier should find gpt-4o-mini (contains 'mini' keyword)
      expect(provider.getModelForTier('haiku')).toBe('gpt-4o-mini');
      // sonnet tier should find gpt-4o (contains '4o' keyword)
      expect(provider.getModelForTier('sonnet')).toBe('gpt-4o');
    });

    it('returns first available model from dynamic cache when no keyword match', () => {
      // Dynamic cache has only an unusual model ID
      (provider as unknown as Record<string, unknown>)['dynamicModelsCache'] = [
        {
          id: 'some-custom-model',
          name: 'Custom (Copilot)',
          alias: 'copilot-custom',
          family: 'gpt',
          provider: 'anthropic-copilot',
          contextWindow: 128000,
          description: 'test',
          releaseDate: '2025-01-01',
          available: true,
        },
      ];
      expect(provider.getModelForTier('haiku')).toBe('some-custom-model');
    });
  });

  describe('isAvailable', () => {
    it('returns false when no credentials available from any source', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        undefined as never
      );
      spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
        undefined as never
      );
      expect(await p.isAvailable()).toBe(false);
    });

    it('returns true when auth.json has a stored token', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue('gho_stored_tok' as never);
      expect(await p.isAvailable()).toBe(true);
    });

    it('returns true when COPILOT_GITHUB_TOKEN env var is set (env vars enable runtime availability)', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_tok' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      expect(await p.isAvailable()).toBe(true);
    });

    it('returns true when GH_TOKEN env var is set (env vars enable runtime availability)', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { GH_TOKEN: 'gho_tok' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      expect(await p.isAvailable()).toBe(true);
    });

    it('returns false for classic PATs (ghp_ prefix) even from env vars', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {
        COPILOT_GITHUB_TOKEN: 'ghp_classicpat',
      });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      expect(await p.isAvailable()).toBe(false);
    });
  });

  describe('getAuthStatus', () => {
    it('reports not authenticated when no stored token in auth.json', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
    });

    it('reports not authenticated when COPILOT_GITHUB_TOKEN env var is set but no auth.json token', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_tok' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
    });

    it('reports not authenticated when GH_TOKEN env var is set but no auth.json token', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { GH_TOKEN: 'gho_tok' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
    });

    it('reports authenticated when auth.json has a stored fine-grained token (gho_ prefix)', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue('gho_stored_tok' as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.needsRefresh).toBe(false);
    });

    it('reports authenticated when auth.json has a fine-grained PAT (github_pat_ prefix)', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue('github_pat_stored' as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
    });

    it('rejects classic PATs (ghp_ prefix) stored in auth.json with an actionable error', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue('ghp_classictoken' as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
      expect(status.error).toContain('Classic PATs');
      expect(status.error).toContain('fine-grained PAT');
    });

    it('does NOT report authenticated for GITHUB_TOKEN env var alone (no auth.json token)', async () => {
      const p = new AnthropicToCopilotBridgeProvider(
        '/tmp',
        { GITHUB_TOKEN: 'gha-tok' },
        '/tmp/no-auth-dir-' + Date.now()
      );
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
    });
  });

  describe('stored credentials', () => {
    it('accepts OAuth access tokens', async () => {
      provider.setCredentials({ type: 'oauth', accessToken: 'gho_access_token' });

      expect(await provider.isAvailable()).toBe(true);
      expect(provider.getCredentials()).toEqual({
        type: 'oauth',
        accessToken: 'gho_access_token',
      });
    });
  });

  describe('buildSdkConfig', () => {
    const fakeServerUrl = 'http://127.0.0.1:54321';

    beforeEach(() => {
      (provider as unknown as Record<string, unknown>)['serverCache'] = {
        url: fakeServerUrl,
        stop: async () => {},
      };
    });

    it('throws when embedded server has not been started', () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      expect(() => p.buildSdkConfig('copilot-anthropic-sonnet')).toThrow(
        'embedded server not started'
      );
    });

    it('returns isAnthropicCompatible=true', () => {
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      expect(cfg.isAnthropicCompatible).toBe(true);
    });

    it('sets ANTHROPIC_AUTH_TOKEN', () => {
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      expect(cfg.envVars['ANTHROPIC_AUTH_TOKEN']).toBeDefined();
    });

    it('encodes workspacePath in ANTHROPIC_AUTH_TOKEN with anthropic-copilot-proxy prefix', () => {
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet', {
        workspacePath: '/my/workspace',
      });
      expect(cfg.envVars['ANTHROPIC_AUTH_TOKEN']).toBe('anthropic-copilot-proxy:/my/workspace');
    });

    it('falls back to provider cwd when workspacePath is absent', () => {
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      const token = cfg.envVars['ANTHROPIC_AUTH_TOKEN'] as string;
      expect(token.startsWith('anthropic-copilot-proxy:')).toBe(true);
    });

    it('ANTHROPIC_BASE_URL uses the injected server URL', () => {
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      const parsedUrl = new URL(cfg.envVars['ANTHROPIC_BASE_URL'] as string);
      expect(parsedUrl.hostname).toBe('127.0.0.1');
      expect(Number(parsedUrl.port)).toBeGreaterThan(0);
    });

    it('sets ANTHROPIC_DEFAULT_SONNET_MODEL to resolved model ID', () => {
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      expect(cfg.envVars['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('claude-sonnet-4.6');
    });

    it('resolves copilot-anthropic-opus alias to claude-opus-4.6', () => {
      const cfg = provider.buildSdkConfig('copilot-anthropic-opus');
      expect(cfg.envVars['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('claude-opus-4.6');
      expect(cfg.envVars['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe('claude-opus-4.6');
    });

    it('sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', () => {
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      expect(cfg.envVars['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
    });

    it('sets ANTHROPIC_API_KEY to empty string to clear real Anthropic key', () => {
      // An empty-string sentinel tells applyEnvVars() to delete process.env.ANTHROPIC_API_KEY,
      // preventing the SDK subprocess from bypassing the embedded proxy and calling
      // api.anthropic.com directly with the user's real key.
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      expect(cfg.envVars['ANTHROPIC_API_KEY']).toBe('');
    });

    it('ANTHROPIC_DEFAULT_HAIKU_MODEL matches the resolved model ID (all tiers use the same Copilot model)', () => {
      // All three SDK model tiers (opus/sonnet/haiku) are set to the resolved Copilot
      // model ID so that every SDK-internal call (summarisation, compaction, etc.)
      // routes through the same real Copilot model rather than a hardcoded fallback
      // that might not be available on the user's Copilot account.
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      expect(cfg.envVars['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe('claude-sonnet-4.6');
      expect(cfg.envVars['ANTHROPIC_DEFAULT_HAIKU_MODEL']).toBe(
        cfg.envVars['ANTHROPIC_DEFAULT_SONNET_MODEL']
      );
    });
  });

  describe('getModels() pre-warms embedded server', () => {
    it('calls ensureServerStarted when auth.json has a stored token', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue('gho_stored_tok' as never);
      const ensureSpy = spyOn(p, 'ensureServerStarted').mockResolvedValue(
        'http://127.0.0.1:9999' as never
      );
      await p.getModels();
      expect(ensureSpy).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when ensureServerStarted fails', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue('gho_stored_tok' as never);
      spyOn(p, 'ensureServerStarted').mockImplementation(() =>
        Promise.reject(new Error('port in use'))
      );
      const models = await p.getModels();
      expect(models).toEqual([]);
    });

    it('returns empty array when no credentials available from any source', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        undefined as never
      );
      spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
        undefined as never
      );
      const models = await p.getModels();
      expect(models).toEqual([]);
    });

    it('calls ensureServerStarted when COPILOT_GITHUB_TOKEN env var is set (env vars enable model listing)', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_env' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      const ensureSpy = spyOn(p, 'ensureServerStarted').mockResolvedValue(
        'http://127.0.0.1:9999' as never
      );
      await p.getModels();
      expect(ensureSpy).toHaveBeenCalledTimes(1);
    });

    it('returns dynamic models from client.listModels() when clientCache is available', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_env' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      spyOn(p, 'ensureServerStarted').mockResolvedValue('http://127.0.0.1:9999' as never);

      // Inject a mock clientCache with listModels()
      const fakeSdkModels = [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          capabilities: {
            supports: { vision: true, reasoningEffort: false },
            limits: { max_context_window_tokens: 128000 },
          },
          policy: { state: 'enabled', terms: '' },
        },
        {
          id: 'claude-sonnet-4-5',
          name: 'Claude Sonnet',
          capabilities: {
            supports: { vision: false, reasoningEffort: false },
            limits: { max_context_window_tokens: 200000 },
          },
          policy: { state: 'enabled', terms: '' },
        },
        // Disabled model should be filtered out
        {
          id: 'gpt-4-turbo',
          name: 'GPT-4 Turbo',
          capabilities: {
            supports: { vision: false, reasoningEffort: false },
            limits: { max_context_window_tokens: 128000 },
          },
          policy: { state: 'disabled', terms: '' },
        },
      ];
      (p as unknown as Record<string, unknown>)['clientCache'] = {
        listModels: async () => fakeSdkModels,
      };

      const models = await p.getModels();

      // Should return dynamic models (filtering out disabled ones)
      expect(models.length).toBe(2);
      expect(models.map((m) => m.id)).toContain('gpt-4o');
      expect(models.map((m) => m.id)).toContain('claude-sonnet-4-5');
      expect(models.map((m) => m.id)).not.toContain('gpt-4-turbo');
      // All should have the correct provider
      for (const m of models) {
        expect(m.provider).toBe('anthropic-copilot');
      }
    });

    it('falls back to static model list when client.listModels() throws', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_env' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      spyOn(p, 'ensureServerStarted').mockResolvedValue('http://127.0.0.1:9999' as never);

      (p as unknown as Record<string, unknown>)['clientCache'] = {
        listModels: async () => {
          throw new Error('API error');
        },
      };

      const models = await p.getModels();
      // Should fall back to static list
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'claude-sonnet-4.6')).toBe(true);
      expect(models.find((m) => m.id === 'gpt-5.4')?.contextWindow).toBe(272000);
      expect(models.find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(272000);
    });

    it('returns cached models within TTL without calling listModels() again', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_env' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      spyOn(p, 'ensureServerStarted').mockResolvedValue('http://127.0.0.1:9999' as never);

      let callCount = 0;
      (p as unknown as Record<string, unknown>)['clientCache'] = {
        listModels: async () => {
          callCount++;
          return [
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              capabilities: {
                supports: { vision: true, reasoningEffort: false },
                limits: { max_context_window_tokens: 128000 },
              },
              policy: { state: 'enabled', terms: '' },
            },
          ];
        },
      };

      // First call — should invoke listModels()
      await p.getModels();
      expect(callCount).toBe(1);

      // Second call within TTL — should return cached result
      await p.getModels();
      expect(callCount).toBe(1); // listModels NOT called again

      // Force expiry
      (p as unknown as Record<string, unknown>)['dynamicModelsCacheExpiresAt'] = Date.now() - 1;

      // Third call after expiry — should invoke listModels() again
      await p.getModels();
      expect(callCount).toBe(2);
    });

    it('falls back to static model list when client.listModels() returns empty', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_env' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      spyOn(p, 'ensureServerStarted').mockResolvedValue('http://127.0.0.1:9999' as never);

      (p as unknown as Record<string, unknown>)['clientCache'] = {
        listModels: async () => [],
      };

      const models = await p.getModels();
      // Should fall back to static list
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'claude-sonnet-4.6')).toBe(true);
      expect(models.find((m) => m.id === 'gpt-5.4')?.contextWindow).toBe(272000);
      expect(models.find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(272000);
    });
  });

  describe('ownsModel() with dynamic models', () => {
    it('returns true for a model ID in the dynamic cache', () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      // Inject a dynamic models cache with a model not in the static list
      (p as unknown as Record<string, unknown>)['dynamicModelsCache'] = [
        {
          id: 'gpt-4o',
          name: 'GPT-4o (Copilot)',
          alias: 'copilot-gpt-4o',
          family: 'gpt',
          provider: 'anthropic-copilot',
          contextWindow: 128000,
          description: 'GPT-4o via GitHub Copilot',
          releaseDate: '2025-01-01',
          available: true,
        },
      ];
      expect(p.ownsModel('gpt-4o')).toBe(true);
      expect(p.ownsModel('copilot-gpt-4o')).toBe(true);
      // Unknown model should still return false
      expect(p.ownsModel('unknown-model-xyz')).toBe(false);
    });
  });

  describe('ensureServerStarted() retry-after-failure', () => {
    it('clears serverStarting on rejection so the next call can retry', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      let callCount = 0;
      spyOn(p as unknown as Record<string, unknown>, 'createServer' as never).mockImplementation(
        async () => {
          callCount++;
          if (callCount === 1) throw new Error('transient failure');
          return { url: 'http://127.0.0.1:9999', stop: async () => {} };
        }
      );

      // First call should reject
      await expect(p.ensureServerStarted()).rejects.toThrow('transient failure');
      // serverStarting must be cleared so the second attempt creates a new promise
      expect((p as unknown as Record<string, unknown>)['serverStarting']).toBeUndefined();

      // Second call should succeed
      const url = await p.ensureServerStarted();
      expect(url).toBe('http://127.0.0.1:9999');
    });

    it('creates only one server when called concurrently', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      let createCount = 0;
      spyOn(p as unknown as Record<string, unknown>, 'createServer' as never).mockImplementation(
        async () => {
          createCount++;
          return { url: 'http://127.0.0.1:9999', stop: async () => {} };
        }
      );

      // Fire three concurrent calls — only one createServer() should occur
      const [url1, url2, url3] = await Promise.all([
        p.ensureServerStarted(),
        p.ensureServerStarted(),
        p.ensureServerStarted(),
      ]);

      expect(createCount).toBe(1);
      expect(url1).toBe('http://127.0.0.1:9999');
      expect(url2).toBe('http://127.0.0.1:9999');
      expect(url3).toBe('http://127.0.0.1:9999');
    });
  });

  describe('shutdown()', () => {
    it('stops the embedded server and clears serverCache', async () => {
      let stopped = false;
      (provider as unknown as Record<string, unknown>)['serverCache'] = {
        url: 'http://127.0.0.1:12345',
        stop: async () => {
          stopped = true;
        },
      };
      await provider.shutdown();
      expect(stopped).toBe(true);
      expect((provider as unknown as Record<string, unknown>)['serverCache']).toBeUndefined();
    });

    it('stops the CopilotClient and clears clientCache', async () => {
      let clientStopped = false;
      (provider as unknown as Record<string, unknown>)['clientCache'] = {
        stop: async () => {
          clientStopped = true;
          return [];
        },
      };
      await provider.shutdown();
      expect(clientStopped).toBe(true);
      expect((provider as unknown as Record<string, unknown>)['clientCache']).toBeUndefined();
    });

    it('is safe to call when server was never started', async () => {
      await expect(provider.shutdown()).resolves.toBeUndefined();
    });

    it('is safe to call twice', async () => {
      (provider as unknown as Record<string, unknown>)['serverCache'] = {
        url: 'http://127.0.0.1:12345',
        stop: async () => {},
      };
      await provider.shutdown();
      await expect(provider.shutdown()).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// loadStoredGitHubToken — source 1 of the credential discovery chain
//
// Tests use spies on the private method rather than real file I/O so they are
// resilient to `mock.module('node:fs/promises', ...)` leaks from other test files.
// ---------------------------------------------------------------------------

describe('loadStoredGitHubToken', () => {
  it('token from auth.json propagates through the chain to isAvailable()=true', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    // Source 1 returns a token (simulates auth.json with github-copilot credentials)
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue('stored-gh-token-abc' as never);
    // Sources 2-3 absent (empty env); sources 4-5 blocked
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    expect(await p.isAvailable()).toBe(true);
  });

  it('absent auth.json (source 1 returns undefined) falls through to sources 2-5', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    // Source 1 returns nothing
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue(undefined as never);
    // All other sources also blocked
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    expect(await p.isAvailable()).toBe(false);
  });

  it('loadStoredGitHubToken is called before env-var sources (source 1 has priority)', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'env-tok' });
    const spy = spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue('stored-tok' as never);
    await p.isAvailable();
    // loadStoredGitHubToken must be called even when COPILOT_GITHUB_TOKEN is set,
    // because source 1 is checked first in discoverGitHubToken().
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// tryGhHostsToken — source 5 of the credential discovery chain
// ---------------------------------------------------------------------------

describe('tryGhHostsToken', () => {
  it('token from hosts.yml DOES make isAvailable()=true (runtime credential discovery uses all sources)', async () => {
    // isAvailable() uses resolveGitHubToken() which checks all 5 sources including hosts.yml.
    // This ensures model listing and session creation work regardless of credential source.
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue(undefined as never);
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      'hosts-token-xyz' as never
    );
    spyOn(
      p as unknown as Record<string, unknown>,
      'validateCopilotToken' as never
    ).mockResolvedValue(true as never);
    expect(await p.isAvailable()).toBe(true);
  });

  it('invalid hosts.yml token (validateCopilotToken=false) does not grant access', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue(undefined as never);
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      'bad-token' as never
    );
    spyOn(
      p as unknown as Record<string, unknown>,
      'validateCopilotToken' as never
    ).mockResolvedValue(false as never);
    expect(await p.isAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// logout()
//
// Tests use spies so they are resilient to mock.module leaks from other files.
// ---------------------------------------------------------------------------

describe('logout()', () => {
  it('invalidates the token cache so the next call re-discovers credentials', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    // Prime the cache by calling isAvailable() — uses resolveGitHubToken() which populates tokenCache
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue('gho_stored_tok' as never);
    expect(await p.isAvailable()).toBe(true);
    // tokenCache is now set (resolveGitHubToken() caches the result)
    expect((p as unknown as Record<string, unknown>)['tokenCache']).toBeDefined();
    // logout() must clear the cache
    await p.logout();
    expect((p as unknown as Record<string, unknown>)['tokenCache']).toBeNull();
  });

  it('calls loadStoredGitHubToken returns undefined after logout clears stored token', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    // Prime the cache with a stored token
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValueOnce('stored-tok' as never);
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    expect(await p.isAvailable()).toBe(true);
    // Simulate logout clearing auth.json (source 1 no longer available)
    await p.logout();
    // After logout the cache is cleared; next call falls through all sources to false
    expect(await p.isAvailable()).toBe(false);
  });

  it('is safe to call twice (idempotent)', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
    await p.logout();
    await expect(p.logout()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// startOAuthFlow()
// ---------------------------------------------------------------------------

describe('startOAuthFlow()', () => {
  it('returns ProviderOAuthFlowData with type=device and required fields', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});

    // Mock the internal device flow fetch so no real network call is made
    spyOn(p as unknown as Record<string, unknown>, 'startDeviceFlow' as never).mockResolvedValue({
      device_code: 'dev-code-123',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    } as never);

    // Prevent background polling from running in the test
    spyOn(
      p as unknown as Record<string, unknown>,
      'startBackgroundPolling' as never
    ).mockResolvedValue(undefined as never);

    const result = await p.startOAuthFlow();
    expect(result.type).toBe('device');
    expect(result.userCode).toBe('ABCD-EFGH');
    expect(result.verificationUri).toBe('https://github.com/login/device');
    expect(typeof result.message).toBe('string');
  });

  it('returns cached flow data if an in-progress flow already exists', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});

    const startDeviceFlowSpy = spyOn(
      p as unknown as Record<string, unknown>,
      'startDeviceFlow' as never
    ).mockResolvedValue({
      device_code: 'dev-code-123',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    } as never);

    spyOn(
      p as unknown as Record<string, unknown>,
      'startBackgroundPolling' as never
    ).mockResolvedValue(undefined as never);

    const first = await p.startOAuthFlow();
    const second = await p.startOAuthFlow();

    // startDeviceFlow called only once — second call returns cached data
    expect(startDeviceFlowSpy).toHaveBeenCalledTimes(1);
    expect(second.userCode).toBe(first.userCode);
  });
});

// ---------------------------------------------------------------------------
// startBackgroundPolling()
// ---------------------------------------------------------------------------

describe('startBackgroundPolling()', () => {
  /** Helper: set activeOAuthFlow directly on the provider instance. */
  function setActiveFlow(p: AnthropicToCopilotBridgeProvider): void {
    (p as unknown as Record<string, unknown>)['activeOAuthFlow'] = {
      deviceCode: 'dev-code-abc',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresAt: Date.now() + 60_000,
      completed: false,
      success: false,
    };
  }

  /** Helper: read activeOAuthFlow from the provider instance. */
  function getActiveFlow(p: AnthropicToCopilotBridgeProvider): {
    completed: boolean;
    success: boolean;
  } {
    return (p as unknown as Record<string, unknown>)['activeOAuthFlow'] as {
      completed: boolean;
      success: boolean;
    };
  }

  /** Minimal DeviceFlowResponse used in all sub-tests. */
  const device = {
    device_code: 'dev-code-abc',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 60,
    interval: 0, // 0-second poll delay so tests complete immediately
  };

  it('slow_down response backs off by 5 s and continues — not terminal', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    setActiveFlow(p);

    // Suppress file I/O
    spyOn(p as unknown as Record<string, unknown>, 'saveCredentials' as never).mockResolvedValue(
      undefined as never
    );

    // Capture all setTimeout delays; run callbacks immediately (0 ms) to avoid
    // the real 5-second wall-clock wait mandated by the RFC 8628 slow_down backoff.
    // This also lets us assert the backoff magnitude was exactly +5 s (5000 ms).
    const sleepDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        sleepDelays.push(delay ?? 0);
        // Run the callback at the next tick but without the real delay.
        return origSetTimeout(fn as () => void, 0, ...(args as []));
      }
    );

    // First call: slow_down — second call: success
    let callCount = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount++;
      const body =
        callCount === 1
          ? JSON.stringify({ error: 'slow_down' })
          : JSON.stringify({ access_token: 'gho_tok123' });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const callPoll = (
        p as unknown as {
          startBackgroundPolling: (d: object, e?: string) => Promise<void>;
        }
      ).startBackgroundPolling;
      await callPoll.call(p, device, undefined);

      // slow_down is NOT terminal — fetch called twice, flow succeeds
      expect(callCount).toBe(2);
      expect(getActiveFlow(p).completed).toBe(true);
      expect(getActiveFlow(p).success).toBe(true);

      // RFC 8628 §3.5: each slow_down must add exactly 5 s to the polling interval.
      // With device.interval=0, the second sleep must be 0+5=5000 ms.
      expect(sleepDelays).toHaveLength(2);
      expect(sleepDelays[0]).toBe(0); // first iteration: interval=0
      expect(sleepDelays[1]).toBe(5000); // after slow_down: interval=0+5 s
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('non-slow_down error terminates the flow with completed=true success=false', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    setActiveFlow(p);

    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'access_denied' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    try {
      const callPoll = (
        p as unknown as {
          startBackgroundPolling: (d: object, e?: string) => Promise<void>;
        }
      ).startBackgroundPolling;
      await callPoll.call(p, device, undefined);

      expect(getActiveFlow(p).completed).toBe(true);
      expect(getActiveFlow(p).success).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

describe('factory registration', () => {
  beforeEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
  });
  afterEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
  });

  it('registers AnthropicToCopilotBridgeProvider with id anthropic-copilot', async () => {
    initializeProviders();
    await waitForOptionalProviderRegistration();
    const registry = getProviderRegistry();
    const p = registry.get('anthropic-copilot');
    expect(p).toBeDefined();
    expect(p?.id).toBe('anthropic-copilot');
  });
});
