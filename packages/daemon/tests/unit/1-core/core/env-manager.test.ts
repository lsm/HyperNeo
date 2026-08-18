import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { EnvManager } from '../../../../src/lib/env-manager';

describe('EnvManager', () => {
  let envManager: EnvManager;
  let originalApiKey: string | undefined;
  let originalOAuthToken: string | undefined;
  let originalAuthToken: string | undefined;
  let originalGlmApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    originalGlmApiKey = process.env.GLM_API_KEY;

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.GLM_API_KEY;

    envManager = new EnvManager();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }

    if (originalOAuthToken !== undefined) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
    } else {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    if (originalAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
    } else {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }

    if (originalGlmApiKey !== undefined) {
      process.env.GLM_API_KEY = originalGlmApiKey;
    } else {
      delete process.env.GLM_API_KEY;
    }
  });

  describe('getApiKey', () => {
    it('should return undefined when no API key is set', () => {
      expect(envManager.getApiKey()).toBeUndefined();
    });

    it('should return API key when set in environment', () => {
      const testKey = 'sk-ant-test-key-123';
      process.env.ANTHROPIC_API_KEY = testKey;

      expect(envManager.getApiKey()).toBe(testKey);
    });

    it('should return latest API key value', () => {
      process.env.ANTHROPIC_API_KEY = 'key-1';
      expect(envManager.getApiKey()).toBe('key-1');

      process.env.ANTHROPIC_API_KEY = 'key-2';
      expect(envManager.getApiKey()).toBe('key-2');
    });

    it('should return ANTHROPIC_AUTH_TOKEN when only that is set', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token-test';
      expect(envManager.getApiKey()).toBe('auth-token-test');
    });

    it('should prefer ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN', () => {
      process.env.ANTHROPIC_API_KEY = 'api-key';
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
      expect(envManager.getApiKey()).toBe('api-key');
    });

    it('should prefer CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_AUTH_TOKEN', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
      expect(envManager.getApiKey()).toBe('oauth-token');
    });
  });

  describe('getOAuthToken', () => {
    it('should return undefined when no OAuth token is set', () => {
      expect(envManager.getOAuthToken()).toBeUndefined();
    });

    it('should return OAuth token when set in environment', () => {
      const testToken = 'claude-oauth-token-xyz';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = testToken;

      expect(envManager.getOAuthToken()).toBe(testToken);
    });

    it('should return latest OAuth token value', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-1';
      expect(envManager.getOAuthToken()).toBe('token-1');

      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-2';
      expect(envManager.getOAuthToken()).toBe('token-2');
    });
  });

  describe('hasCredentials', () => {
    it('should return false when no credentials are set', () => {
      expect(envManager.hasCredentials()).toBe(false);
    });

    it('should return true when API key is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      expect(envManager.hasCredentials()).toBe(true);
    });

    it('should return true when OAuth token is set', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
      expect(envManager.hasCredentials()).toBe(true);
    });

    it('should return true when both credentials are set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';
      expect(envManager.hasCredentials()).toBe(true);
    });

    it('should handle empty string credentials as falsy', () => {
      process.env.ANTHROPIC_API_KEY = '';
      expect(envManager.hasCredentials()).toBe(false);
    });

    it('should return true when ANTHROPIC_AUTH_TOKEN is set', () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token';
      expect(envManager.hasCredentials()).toBe(true);
    });
  });

  describe('constructor', () => {
    it('should accept optional envPath parameter for backward compatibility', () => {
      expect(() => new EnvManager('/some/path/.env')).not.toThrow();
    });

    it('should work without envPath parameter', () => {
      expect(() => new EnvManager()).not.toThrow();
    });
  });

  describe('read-only behavior', () => {
    it('should reflect environment changes immediately', () => {
      expect(envManager.hasCredentials()).toBe(false);

      process.env.ANTHROPIC_API_KEY = 'new-key';
      expect(envManager.hasCredentials()).toBe(true);
      expect(envManager.getApiKey()).toBe('new-key');

      delete process.env.ANTHROPIC_API_KEY;
      expect(envManager.hasCredentials()).toBe(false);
      expect(envManager.getApiKey()).toBeUndefined();
    });

    it('should support multiple EnvManager instances reading same env', () => {
      const manager1 = new EnvManager();
      const manager2 = new EnvManager();

      process.env.ANTHROPIC_API_KEY = 'shared-key';

      expect(manager1.getApiKey()).toBe('shared-key');
      expect(manager2.getApiKey()).toBe('shared-key');
    });
  });
});
