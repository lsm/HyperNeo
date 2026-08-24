import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import { removeProviderFromRegistry } from '../../../../../src/lib/providers/provider-sync';

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
      expect(provider.getModelForTier('haiku')).toBe('gpt-4o-mini');
      expect(provider.getModelForTier('sonnet')).toBe('gpt-4o');
    });

    it('returns first available model from dynamic cache when no keyword match', () => {
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
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        undefined as never
      );
      spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
        undefined as never
      );
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
    });

    it('classifies malformed stored credentials as transient', async () => {
      const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-status-'));
      fs.writeFileSync(path.join(authDir, 'auth.json'), '{invalid json');
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {}, authDir);

      try {
        const status = await p.getAuthStatus();

        expect(status.isAuthenticated).toBe(false);
        expect(status.errorKind).toBe('transient');
      } finally {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    });

    it('keeps availability resilient when stored credentials are malformed', async () => {
      const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-status-'));
      fs.writeFileSync(path.join(authDir, 'auth.json'), '{invalid json');
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {}, authDir);
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        undefined as never
      );
      spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
        undefined as never
      );

      try {
        await expect(p.isAvailable()).resolves.toBe(false);
        await expect(p.getAuthStatus()).resolves.toMatchObject({
          isAuthenticated: false,
          errorKind: 'transient',
        });
        await expect(p.getCredentials()).resolves.toBeNull();
      } finally {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    });

    it('uses a fallback token when stored credentials are malformed', async () => {
      const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-status-'));
      fs.writeFileSync(path.join(authDir, 'auth.json'), '{invalid json');
      const p = new AnthropicToCopilotBridgeProvider(
        '/tmp',
        { COPILOT_GITHUB_TOKEN: 'gho_env' },
        authDir
      );

      try {
        await expect(p.getAuthStatus()).resolves.toMatchObject({ isAuthenticated: true });
        await expect(p.isAvailable()).resolves.toBe(true);
      } finally {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    });

    it('treats a missing stored credentials file as logged out', async () => {
      const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-status-'));
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {}, authDir);
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        undefined as never
      );
      spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
        undefined as never
      );

      try {
        const status = await p.getAuthStatus();

        expect(status.isAuthenticated).toBe(false);
        expect(status.errorKind).toBeUndefined();
      } finally {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    });

    it('reports authenticated when COPILOT_GITHUB_TOKEN env var is set (same discovery chain as isAvailable)', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_tok' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
    });

    it('reports authenticated when GH_TOKEN env var is set (same discovery chain as isAvailable)', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { GH_TOKEN: 'gho_tok' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
    });

    it('reports authenticated when only a gh CLI token is discoverable', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        'gho_cli_tok' as never
      );
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
    });

    it('reports authenticated when only a hosts.yml token is discoverable', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        undefined as never
      );
      spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
        'gho_hosts_tok' as never
      );
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
    });

    it('agrees with isAvailable for env-token installs (both resolve the same chain)', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_tok' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      expect(await p.isAvailable()).toBe(true);
      expect((await p.getAuthStatus()).isAuthenticated).toBe(true);
    });

    it('rejects classic PATs (ghp_ prefix) from env vars with an actionable error', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'ghp_pat' });
      spyOn(
        p as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
      expect(status.error).toContain('Classic PATs');
      expect(status.error).toContain('fine-grained PAT');
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
      spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
        undefined as never
      );
      spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
        undefined as never
      );
      const status = await p.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
    });
  });

  describe('stored credentials', () => {
    it('accepts OAuth access tokens', async () => {
      provider.setCredentials({ type: 'oauth', accessToken: 'gho_access_token' });

      expect(await provider.isAvailable()).toBe(true);
      expect(await provider.getCredentials()).toEqual({
        type: 'oauth',
        accessToken: 'gho_access_token',
      });
    });

    it('reports stored credential-store tokens as authenticated', async () => {
      provider.setCredentials({ type: 'oauth', accessToken: 'gho_access_token' });

      const status = await provider.getAuthStatus();

      expect(status.isAuthenticated).toBe(true);
      expect(status.needsRefresh).toBe(false);
    });

    it('keeps stored credential-store tokens beyond token cache expiry', async () => {
      provider.setCredentials({ type: 'oauth', accessToken: 'gho_access_token' });
      (provider as unknown as Record<string, unknown>)['tokenCache'] = {
        token: 'gho_access_token',
        expiresAt: Date.now() - 1,
      };
      spyOn(
        provider as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue(undefined as never);

      expect(await provider.isAvailable()).toBe(true);
    });

    it('notifies listeners when provider-owned OAuth credentials are saved', async () => {
      const seen: unknown[] = [];
      const unsubscribe = provider.onCredentialsChanged((credentials) => seen.push(credentials));

      (provider as unknown as Record<string, unknown>)['notifyCredentialsChanged']({
        type: 'oauth',
        accessToken: 'new-copilot-token',
      });
      unsubscribe();

      expect(seen).toEqual([{ type: 'oauth', accessToken: 'new-copilot-token' }]);
    });

    it('reads auth file when no in-memory token exists', async () => {
      spyOn(
        provider as unknown as Record<string, unknown>,
        'loadStoredGitHubToken' as never
      ).mockResolvedValue('file-auth-token' as never);

      expect(await provider.getCredentials()).toEqual({
        type: 'oauth',
        accessToken: 'file-auth-token',
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
      const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
      expect(cfg.envVars['ANTHROPIC_API_KEY']).toBe('');
    });

    it('ANTHROPIC_DEFAULT_HAIKU_MODEL matches the resolved model ID (all tiers use the same Copilot model)', () => {
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

      expect(models.length).toBe(2);
      expect(models.map((m) => m.id)).toContain('gpt-4o');
      expect(models.map((m) => m.id)).toContain('claude-sonnet-4-5');
      expect(models.map((m) => m.id)).not.toContain('gpt-4-turbo');
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

      await p.getModels();
      expect(callCount).toBe(1);

      await p.getModels();
      expect(callCount).toBe(1);

      (p as unknown as Record<string, unknown>)['dynamicModelsCacheExpiresAt'] = Date.now() - 1;

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
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === 'claude-sonnet-4.6')).toBe(true);
      expect(models.find((m) => m.id === 'gpt-5.4')?.contextWindow).toBe(272000);
      expect(models.find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(272000);
    });
  });

  describe('ownsModel() with dynamic models', () => {
    it('returns true for a model ID in the dynamic cache', () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
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
      expect(p.ownsModel('unknown-model-xyz')).toBe(false);
    });
  });

  describe('setCredentials() credential mutation', () => {
    function fakeRuntime(): { server: unknown; client: unknown; stops: string[] } {
      const stops: string[] = [];
      return {
        stops,
        server: {
          url: 'http://127.0.0.1:45678',
          stop: async () => {
            stops.push('server');
          },
        },
        client: {
          stop: async () => {
            stops.push('client');
          },
        },
      };
    }

    function fakeModel(): Record<string, unknown> {
      return {
        id: 'gpt-4o',
        name: 'GPT-4o (Copilot)',
        alias: 'copilot-gpt-4o',
        family: 'gpt',
        provider: 'anthropic-copilot',
        contextWindow: 128000,
        description: 'GPT-4o via GitHub Copilot',
        releaseDate: '2025-01-01',
        available: true,
      };
    }

    async function settle(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('tears down dynamic models, client, and server caches when the token changes', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      const runtime = fakeRuntime();
      (p as unknown as Record<string, unknown>)['serverCache'] = runtime.server;
      (p as unknown as Record<string, unknown>)['clientCache'] = runtime.client;
      (p as unknown as Record<string, unknown>)['dynamicModelsCache'] = [fakeModel()];
      (p as unknown as Record<string, unknown>)['dynamicModelsCacheExpiresAt'] =
        Date.now() + 60_000;

      p.setCredentials({ type: 'oauth', accessToken: 'gho_replacement_token' });
      await settle();

      const state = p as unknown as Record<string, unknown>;
      expect(runtime.stops).toEqual(['server', 'client']);
      expect(state['serverCache']).toBeUndefined();
      expect(state['clientCache']).toBeUndefined();
      expect(state['dynamicModelsCache']).toBeNull();
      expect(state['dynamicModelsCacheExpiresAt']).toBe(0);
      expect(state['storedCredentialToken']).toBe('gho_replacement_token');
    });

    it('keeps runtime caches when the same token is re-applied', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      p.setCredentials({ type: 'oauth', accessToken: 'gho_same_token' });
      const runtime = fakeRuntime();
      (p as unknown as Record<string, unknown>)['serverCache'] = runtime.server;
      (p as unknown as Record<string, unknown>)['clientCache'] = runtime.client;
      (p as unknown as Record<string, unknown>)['dynamicModelsCache'] = [fakeModel()];
      (p as unknown as Record<string, unknown>)['dynamicModelsCacheExpiresAt'] =
        Date.now() + 60_000;

      p.setCredentials({ type: 'oauth', accessToken: 'gho_same_token' });
      await settle();

      const state = p as unknown as Record<string, unknown>;
      expect(runtime.stops).toEqual([]);
      expect(state['serverCache']).toBe(runtime.server);
      expect(state['clientCache']).toBe(runtime.client);
      expect(state['dynamicModelsCache']).toEqual([fakeModel()]);
    });

    it('stops a server that is still starting when credentials change', async () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      const stops: string[] = [];
      let resolveStart: ((server: unknown) => void) | undefined;
      const starting = new Promise<unknown>((resolve) => {
        resolveStart = resolve;
      });
      (p as unknown as Record<string, unknown>)['serverStarting'] = starting;

      p.setCredentials({ type: 'oauth', accessToken: 'gho_replacement_token' });
      await settle();
      expect((p as unknown as Record<string, unknown>)['serverStarting']).toBeUndefined();

      resolveStart?.({
        url: 'http://127.0.0.1:45679',
        stop: async () => {
          stops.push('server');
        },
      });
      await settle();
      await settle();

      expect(stops).toEqual(['server']);
      expect((p as unknown as Record<string, unknown>)['serverCache']).toBeUndefined();
    });

    it('clears dynamic model caches through clearModelCache()', () => {
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
      (p as unknown as Record<string, unknown>)['dynamicModelsCache'] = [fakeModel()];
      (p as unknown as Record<string, unknown>)['dynamicModelsCacheExpiresAt'] =
        Date.now() + 60_000;

      p.clearModelCache();

      const state = p as unknown as Record<string, unknown>;
      expect(state['dynamicModelsCache']).toBeNull();
      expect(state['dynamicModelsCacheExpiresAt']).toBe(0);
    });

    it('resets the credential-bound runtime when the OAuth flow completes', async () => {
      const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-oauth-reset-'));
      const p = new AnthropicToCopilotBridgeProvider('/tmp', {}, authDir);
      const stops: string[] = [];
      (p as unknown as Record<string, unknown>)['serverCache'] = {
        url: 'http://127.0.0.1:45680',
        stop: async () => {
          stops.push('server');
        },
      };
      (p as unknown as Record<string, unknown>)['clientCache'] = {
        stop: async () => {
          stops.push('client');
        },
      };
      (p as unknown as Record<string, unknown>)['dynamicModelsCache'] = [fakeModel()];
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/login/device/code')) {
          return new Response(
            JSON.stringify({
              device_code: 'device-code',
              user_code: 'ABCD-1234',
              verification_uri: 'https://github.com/login/device',
              expires_in: 5,
              interval: 0,
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ access_token: 'gho_oauth_completed' }), {
          status: 200,
        });
      });

      try {
        await p.startOAuthFlow();
        for (let i = 0; i < 20 && stops.length < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }

        const state = p as unknown as Record<string, unknown>;
        expect(stops).toEqual(['server', 'client']);
        expect(state['serverCache']).toBeUndefined();
        expect(state['clientCache']).toBeUndefined();
        expect(state['dynamicModelsCache']).toBeNull();
        expect(state['storedCredentialToken']).toBeNull();
        expect(state['tokenCache']).toBeNull();
      } finally {
        fetchSpy.mockRestore();
        fs.rmSync(authDir, { recursive: true, force: true });
      }
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

      await expect(p.ensureServerStarted()).rejects.toThrow('transient failure');
      expect((p as unknown as Record<string, unknown>)['serverStarting']).toBeUndefined();

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

describe('loadStoredGitHubToken', () => {
  it('token from auth.json propagates through the chain to isAvailable()=true', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue('stored-gh-token-abc' as never);
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

  it('loadStoredGitHubToken is called before env-var sources (source 1 has priority)', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'env-tok' });
    const spy = spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue('stored-tok' as never);
    await p.isAvailable();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('tryGhHostsToken', () => {
  it('token from hosts.yml DOES make isAvailable()=true (runtime credential discovery uses all sources)', async () => {
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
    expect(await p.isAvailable()).toBe(true);
  });

  it('hosts.yml token grants availability by presence alone — no subprocess token validation', async () => {
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
    expect(await p.isAvailable()).toBe(true);
  });

  it('gh CLI token (keyring-backed installs) grants availability by presence alone', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue(undefined as never);
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      'gho_cli_tok' as never
    );
    expect(await p.isAvailable()).toBe(true);
  });
});

describe('logout()', () => {
  it('invalidates the token cache so the next call re-discovers credentials', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    spyOn(
      p as unknown as Record<string, unknown>,
      'loadStoredGitHubToken' as never
    ).mockResolvedValue('gho_stored_tok' as never);
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    expect(await p.isAvailable()).toBe(true);
    expect((p as unknown as Record<string, unknown>)['tokenCache']).toBeDefined();
    await p.logout();
    expect((p as unknown as Record<string, unknown>)['tokenCache']).toBeNull();
  });

  it('calls loadStoredGitHubToken returns undefined after logout clears stored token', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
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
    await p.logout();
    expect(await p.isAvailable()).toBe(false);
  });

  it('is safe to call twice (idempotent)', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    await p.logout();
    await expect(p.logout()).resolves.toBeUndefined();
  });

  it('rejects logout with an actionable error while COPILOT_GITHUB_TOKEN manages credentials', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_tok' });
    await expect(p.logout()).rejects.toThrow('COPILOT_GITHUB_TOKEN');
  });

  it('rejects logout with an actionable error while GH_TOKEN manages credentials', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', { GH_TOKEN: 'gho_tok' });
    await expect(p.logout()).rejects.toThrow('GH_TOKEN');
  });

  it('rejects logout with an actionable error while a gh CLI token manages credentials', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      'gho_cli_tok' as never
    );
    await expect(p.logout()).rejects.toThrow('gh CLI');
  });

  it('clears owned credentials even when an external source keeps the provider authenticated', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'gho_tok' });
    p.setCredentials({ type: 'oauth', accessToken: 'gho_stored_tok' });
    await expect(p.logout()).rejects.toThrow('COPILOT_GITHUB_TOKEN');
    expect((p as unknown as Record<string, unknown>)['storedCredentialToken']).toBeNull();
    expect((p as unknown as Record<string, unknown>)['tokenCache']).toBeNull();
  });

  it('does not block logout for an unusable classic PAT (ghp_) in COPILOT_GITHUB_TOKEN', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'ghp_classic' });
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    await expect(p.logout()).resolves.toBeUndefined();
  });

  it('does not block logout when a ghp_ COPILOT_GITHUB_TOKEN shadows a usable GH_TOKEN (discovery precedence)', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {
      COPILOT_GITHUB_TOKEN: 'ghp_classic',
      GH_TOKEN: 'gho_valid',
    });
    await expect(p.logout()).resolves.toBeUndefined();
  });

  it('does not block logout for an unusable classic PAT (ghp_) from the gh CLI', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      'ghp_cli_classic' as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    await expect(p.logout()).resolves.toBeUndefined();
  });

  it('refuses logout using cached gh-token provenance when the live gh CLI lookup transiently fails', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    (p as unknown as Record<string, unknown>)['tokenCache'] = {
      token: 'gho_cli_tok',
      expiresAt: Date.now() + 60_000,
      source: 'gh-cli',
    };
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    await expect(p.logout()).rejects.toThrow('gh CLI');
  });

  it('does not refuse logout from cached provenance when the cached source is the auth file', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    (p as unknown as Record<string, unknown>)['tokenCache'] = {
      token: 'gho_file_tok',
      expiresAt: Date.now() + 60_000,
      source: 'auth-file',
    };
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    await expect(p.logout()).resolves.toBeUndefined();
  });

  it('ignores expired cached provenance when the live lookup finds no external source', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    (p as unknown as Record<string, unknown>)['tokenCache'] = {
      token: 'gho_cli_tok',
      expiresAt: Date.now() - 1,
      source: 'gh-cli',
    };
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    await expect(p.logout()).resolves.toBeUndefined();
  });

  it('does not refuse logout from cached provenance when discovery cached no token', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    (p as unknown as Record<string, unknown>)['tokenCache'] = {
      token: undefined,
      expiresAt: Date.now() + 60_000,
      source: 'hosts',
    };
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    await expect(p.logout()).resolves.toBeUndefined();
  });

  it('does not refuse logout from cached provenance when the cached token is an unusable classic PAT', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    (p as unknown as Record<string, unknown>)['tokenCache'] = {
      token: 'ghp_cli_classic',
      expiresAt: Date.now() + 60_000,
      source: 'gh-cli',
    };
    spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
      undefined as never
    );
    spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
      undefined as never
    );
    await expect(p.logout()).resolves.toBeUndefined();
  });
});

describe('disable path preserves OAuth credentials', () => {
  let authDir: string;

  beforeEach(() => {
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-auth-'));
    resetProviderRegistry();
    resetProviderFactory();
  });

  afterEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  function writeAuthJson(data: Record<string, unknown>): void {
    fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify(data, null, 2));
  }

  function readAuthJson(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(authDir, 'auth.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
  }

  it('registry removal with preserveCredentials keeps the github-copilot entry and re-enable recovers from it', async () => {
    writeAuthJson({ 'github-copilot': { refresh: 'gho_disable_tok' } });
    const provider = new AnthropicToCopilotBridgeProvider('/tmp', {}, authDir);
    getProviderRegistry().register(provider);

    await removeProviderFromRegistry('anthropic-copilot', { preserveCredentials: true });

    expect(getProviderRegistry().has('anthropic-copilot')).toBe(false);
    expect(readAuthJson()['github-copilot']).toEqual({ refresh: 'gho_disable_tok' });

    const reEnabled = new AnthropicToCopilotBridgeProvider('/tmp', {}, authDir);
    expect(await reEnabled.getCredentials()).toEqual({
      type: 'oauth',
      accessToken: 'gho_disable_tok',
    });
    expect((await reEnabled.getAuthStatus()).isAuthenticated).toBe(true);
  });

  it('registry removal without preserveCredentials deletes the github-copilot entry', async () => {
    writeAuthJson({ 'github-copilot': { refresh: 'gho_tok' }, 'other-provider': { token: 'x' } });
    const provider = new AnthropicToCopilotBridgeProvider('/tmp', {}, authDir);
    getProviderRegistry().register(provider);

    await removeProviderFromRegistry('anthropic-copilot');

    const data = readAuthJson();
    expect(data['github-copilot']).toBeUndefined();
    expect(data['other-provider']).toEqual({ token: 'x' });
  });
});

describe('startOAuthFlow()', () => {
  it('returns ProviderOAuthFlowData with type=device and required fields', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});

    spyOn(p as unknown as Record<string, unknown>, 'startDeviceFlow' as never).mockResolvedValue({
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

    expect(startDeviceFlowSpy).toHaveBeenCalledTimes(1);
    expect(second.userCode).toBe(first.userCode);
  });
});

describe('startBackgroundPolling()', () => {
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

  function getActiveFlow(p: AnthropicToCopilotBridgeProvider): {
    completed: boolean;
    success: boolean;
  } {
    return (p as unknown as Record<string, unknown>)['activeOAuthFlow'] as {
      completed: boolean;
      success: boolean;
    };
  }

  const device = {
    device_code: 'dev-code-abc',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 60,
    interval: 0,
  };

  it('slow_down response backs off by 5 s and continues — not terminal', async () => {
    const p = new AnthropicToCopilotBridgeProvider('/tmp', {});
    setActiveFlow(p);

    spyOn(p as unknown as Record<string, unknown>, 'saveCredentials' as never).mockResolvedValue(
      undefined as never
    );

    const sleepDelays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (fn: TimerHandler, delay?: number, ...args: unknown[]) => {
        sleepDelays.push(delay ?? 0);
        return origSetTimeout(fn as () => void, 0, ...(args as []));
      }
    );

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

      expect(callCount).toBe(2);
      expect(getActiveFlow(p).completed).toBe(true);
      expect(getActiveFlow(p).success).toBe(true);

      expect(sleepDelays).toHaveLength(2);
      expect(sleepDelays[0]).toBe(0);
      expect(sleepDelays[1]).toBe(5000);
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
