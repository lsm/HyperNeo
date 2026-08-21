import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { discoverCredentials } from '../../../../src/lib/credential-discovery';

describe('discoverCredentials', () => {
  let originalEnv: Record<string, string | undefined>;
  let tempDir: string;
  let claudeDir: string;

  beforeEach(() => {
    originalEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    };

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete process.env.API_TIMEOUT_MS;
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;

    tempDir = join(
      process.env.TMPDIR || '/tmp',
      `hyperneo-cred-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    claudeDir = join(tempDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('return value contract', () => {
    it('should return a valid DiscoveryResult', () => {
      const result = discoverCredentials(claudeDir);
      expect(result).toHaveProperty('credentialSource');
      expect(result).toHaveProperty('settingsEnvApplied');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
      expect(typeof result.settingsEnvApplied).toBe('number');
    });

    it('should never throw even with missing directory', () => {
      expect(() => discoverCredentials('/nonexistent/path/.claude')).not.toThrow();
    });
  });

  describe('env-only credentials', () => {
    it('should return "env" source when all credentials already present', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test';
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-test';

      const result = discoverCredentials(claudeDir);
      expect(result.credentialSource).toBe('env');
    });

    it('should not overwrite existing ANTHROPIC_API_KEY', () => {
      process.env.ANTHROPIC_API_KEY = 'my-explicit-key';
      discoverCredentials(claudeDir);
      expect(process.env.ANTHROPIC_API_KEY).toBe('my-explicit-key');
    });

    it('should not overwrite existing CLAUDE_CODE_OAUTH_TOKEN', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'my-explicit-token';
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } })
      );
      discoverCredentials(claudeDir);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('my-explicit-token');
    });

    it('should not overwrite existing ANTHROPIC_AUTH_TOKEN from settings.json', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'my-explicit-auth';
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'settings-auth' } })
      );
      discoverCredentials(claudeDir);
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('my-explicit-auth');
    });

    it('should be idempotent', () => {
      process.env.ANTHROPIC_API_KEY = 'key-1';
      discoverCredentials(claudeDir);
      discoverCredentials(claudeDir);
      expect(process.env.ANTHROPIC_API_KEY).toBe('key-1');
    });
  });

  describe('.credentials.json reading', () => {
    it('should discover OAuth token from .credentials.json', () => {
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'discovered-oauth-token',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 86400000,
          },
        })
      );

      const result = discoverCredentials(claudeDir);
      expect(result.credentialSource).toBe('credentials-file');
      expect(result.errors).toHaveLength(0);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('discovered-oauth-token');
    });

    it('should handle malformed .credentials.json', () => {
      writeFileSync(join(claudeDir, '.credentials.json'), '{ not valid json }');

      const result = discoverCredentials(claudeDir, { platformName: 'linux' });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('.credentials.json');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('should handle .credentials.json without claudeAiOauth field', () => {
      writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify({ otherField: 'value' }));

      const result = discoverCredentials(claudeDir, { platformName: 'linux' });
      expect(result.errors).toHaveLength(0);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('should handle .credentials.json with null accessToken', () => {
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: null } })
      );

      const _result = discoverCredentials(claudeDir, { platformName: 'linux' });
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('should skip .credentials.json if CLAUDE_CODE_OAUTH_TOKEN already set', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'existing';
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } })
      );

      const _result = discoverCredentials(claudeDir);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('existing');
    });

    it('should handle missing .claude directory', () => {
      rmSync(claudeDir, { recursive: true, force: true });
      const result = discoverCredentials(claudeDir, { platformName: 'linux' });
      expect(result.credentialSource).toBe('none');
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('settings.json env block', () => {
    it('should inject env vars from settings.json', () => {
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'zhipu-key',
            ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
            API_TIMEOUT_MS: '3000000',
          },
        })
      );

      const result = discoverCredentials(claudeDir, { platformName: 'linux' });
      expect(result.settingsEnvApplied).toBe(4);
      expect(result.credentialSource).toBe('settings-json');
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('zhipu-key');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5');
      expect(process.env.API_TIMEOUT_MS).toBe('3000000');
    });

    it('should not overwrite existing env vars from settings.json', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'explicit';
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'from-settings',
            ANTHROPIC_BASE_URL: 'https://example.com',
          },
        })
      );

      const result = discoverCredentials(claudeDir);
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('explicit');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://example.com');
      expect(result.settingsEnvApplied).toBe(1);
    });

    it('should handle malformed settings.json', () => {
      writeFileSync(join(claudeDir, 'settings.json'), 'not json');

      const result = discoverCredentials(claudeDir);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('settings.json');
    });

    it('should handle settings.json without env block', () => {
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ allowedTools: ['Bash'] }));

      const result = discoverCredentials(claudeDir);
      expect(result.settingsEnvApplied).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle missing settings.json', () => {
      const result = discoverCredentials(claudeDir);
      expect(result.settingsEnvApplied).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should convert non-string values to strings', () => {
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          env: {
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
            API_TIMEOUT_MS: 3000000,
          },
        })
      );

      const result = discoverCredentials(claudeDir);
      expect(result.settingsEnvApplied).toBe(2);
      expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
      expect(process.env.API_TIMEOUT_MS).toBe('3000000');
    });
  });

  describe('combined sources', () => {
    it('should read both .credentials.json and settings.json', () => {
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'my-token' } })
      );
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com', API_TIMEOUT_MS: '5000' },
        })
      );

      const result = discoverCredentials(claudeDir);
      expect(result.credentialSource).toBe('credentials-file');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('my-token');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
      expect(result.settingsEnvApplied).toBe(2);
    });

    it('should handle full Zhipu GLM scenario', () => {
      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
            ANTHROPIC_AUTH_TOKEN: 'zhipu_key',
            ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
            API_TIMEOUT_MS: '3000000',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
          },
        })
      );

      const result = discoverCredentials(claudeDir, { platformName: 'linux' });
      expect(result.credentialSource).toBe('settings-json');
      expect(result.settingsEnvApplied).toBe(7);
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('zhipu_key');
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5');
    });
  });

  describe('macOS Keychain discovery', () => {
    it('should discover OAuth token from macOS Keychain', () => {
      const result = discoverCredentials(claudeDir, {
        platformName: 'darwin',
        keychainReader: () => JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } }),
      });

      expect(result.credentialSource).toBe('keychain');
      expect(result.errors).toHaveLength(0);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('keychain-token');
    });

    it('should skip keychain on non-macOS platforms', () => {
      const keychainReaderCalled = { value: false };
      const result = discoverCredentials(claudeDir, {
        platformName: 'linux',
        keychainReader: () => {
          keychainReaderCalled.value = true;
          return JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } });
        },
      });

      expect(keychainReaderCalled.value).toBe(false);
      expect(result.credentialSource).toBe('none');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('should handle keychain access denied', () => {
      const result = discoverCredentials(claudeDir, {
        platformName: 'darwin',
        keychainReader: () => {
          throw new Error('keychain access denied');
        },
      });

      expect(result.credentialSource).not.toBe('keychain');
      expect(result.errors).toHaveLength(0);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('should handle malformed keychain JSON', () => {
      const result = discoverCredentials(claudeDir, {
        platformName: 'darwin',
        keychainReader: () => 'not valid json',
      });

      expect(result.credentialSource).not.toBe('keychain');
      expect(result.errors).toHaveLength(0);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('should handle keychain JSON without accessToken', () => {
      const result = discoverCredentials(claudeDir, {
        platformName: 'darwin',
        keychainReader: () => JSON.stringify({ otherField: 'value' }),
      });

      expect(result.credentialSource).not.toBe('keychain');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('should skip keychain when CLAUDE_CODE_OAUTH_TOKEN already set', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'existing';
      const keychainReaderCalled = { value: false };

      discoverCredentials(claudeDir, {
        platformName: 'darwin',
        keychainReader: () => {
          keychainReaderCalled.value = true;
          return JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } });
        },
      });

      expect(keychainReaderCalled.value).toBe(false);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('existing');
    });

    it('should skip keychain when credentials.json already provides token', () => {
      writeFileSync(
        join(claudeDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } })
      );

      const keychainReaderCalled = { value: false };
      const _result = discoverCredentials(claudeDir, {
        platformName: 'darwin',
        keychainReader: () => {
          keychainReaderCalled.value = true;
          return JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } });
        },
      });

      expect(keychainReaderCalled.value).toBe(false);
      expect(_result.credentialSource).toBe('credentials-file');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('file-token');
    });
  });

  describe('catch-all error handler', () => {
    it('should catch unexpected errors during credential discovery', () => {
      const problematicPath = '/nonexistent/\x00/path/.claude';

      const result = discoverCredentials(problematicPath);

      expect(result).toHaveProperty('credentialSource');
      expect(result).toHaveProperty('settingsEnvApplied');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it('should handle malformed JSON in settings.json gracefully', () => {
      writeFileSync(join(claudeDir, 'settings.json'), '{ malformed json }');

      const result = discoverCredentials(claudeDir);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('settings.json');

      expect(result.credentialSource).toBeDefined();
      expect(typeof result.settingsEnvApplied).toBe('number');
    });

    it('should handle malformed JSON in .credentials.json gracefully', () => {
      writeFileSync(join(claudeDir, '.credentials.json'), '{ invalid }');

      const result = discoverCredentials(claudeDir);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('.credentials.json');

      expect(result.credentialSource).toBeDefined();
      expect(typeof result.settingsEnvApplied).toBe('number');
    });

    it('should return valid result even with multiple errors', () => {
      writeFileSync(join(claudeDir, 'settings.json'), '{ bad1 }');
      writeFileSync(join(claudeDir, '.credentials.json'), '{ bad2 }');

      const result = discoverCredentials(claudeDir);

      expect(result.errors.length).toBeGreaterThanOrEqual(1);

      expect(result).toHaveProperty('credentialSource');
      expect(result).toHaveProperty('settingsEnvApplied');
      expect(result).toHaveProperty('errors');
    });
  });

  describe('when all 3 credentials are present but settings.json still applies', () => {
    it('should apply settings.json env vars even when all 3 credentials are already present', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-test-token';

      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://custom.example.com',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-model-123',
            API_TIMEOUT_MS: '60000',
          },
        })
      );

      const result = discoverCredentials(claudeDir);

      expect(result.credentialSource).toBe('env');

      expect(result.settingsEnvApplied).toBe(3);
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://custom.example.com');
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('custom-model-123');
      expect(process.env.API_TIMEOUT_MS).toBe('60000');

      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test-token');
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('auth-test-token');
    });

    it('should not overwrite existing env vars from settings.json when all 3 credentials present', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-test-token';
      process.env.ANTHROPIC_BASE_URL = 'existing-url';

      writeFileSync(
        join(claudeDir, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://new.example.com',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'new-model',
          },
        })
      );

      const result = discoverCredentials(claudeDir);

      expect(result.credentialSource).toBe('env');

      expect(result.settingsEnvApplied).toBe(1);
      expect(process.env.ANTHROPIC_BASE_URL).toBe('existing-url');
      expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('new-model');
    });

    it('should handle empty settings.json when all 3 credentials present', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-test-token';

      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({}));

      const result = discoverCredentials(claudeDir);

      expect(result.credentialSource).toBe('env');

      expect(result.settingsEnvApplied).toBe(0);
    });
  });
});
