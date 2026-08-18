import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { AuthManager } from '../../../../src/lib/auth-manager';

describe('AuthManager', () => {
  let authManager: AuthManager;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.GLM_API_KEY;

    authManager = new AuthManager();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await expect(authManager.initialize()).resolves.toBeUndefined();
    });
  });

  describe('getAuthStatus', () => {
    it('should return not authenticated when no credentials', async () => {
      const status = await authManager.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
      expect(status.method).toBe('none');
      expect(status.source).toBe('env');
    });

    it('should return authenticated with API key', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

      const status = await authManager.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.method).toBe('api_key');
      expect(status.source).toBe('env');
    });

    it('should return authenticated with OAuth token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';

      const status = await authManager.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.method).toBe('oauth_token');
      expect(status.source).toBe('env');
    });

    it('should prefer OAuth token over API key', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';

      const status = await authManager.getAuthStatus();
      expect(status.method).toBe('oauth_token');
    });

    it('should include user object for OAuth token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';

      const status = await authManager.getAuthStatus();
      expect(status.user).toBeDefined();
    });

    it('should return authenticated with ANTHROPIC_AUTH_TOKEN', async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-test-token';

      const status = await authManager.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.method).toBe('api_key');
      expect(status.source).toBe('env');
    });

    it('should prefer OAuth token over ANTHROPIC_AUTH_TOKEN', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';
      process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-test-token';

      const status = await authManager.getAuthStatus();
      expect(status.method).toBe('oauth_token');
    });

    it('should prefer API key over ANTHROPIC_AUTH_TOKEN', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-test-token';

      const status = await authManager.getAuthStatus();
      expect(status.method).toBe('api_key');
      const key = await authManager.getCurrentApiKey();
      expect(key).toBe('sk-ant-test-key');
    });
  });

  describe('getCurrentApiKey', () => {
    it('should return null when no credentials', async () => {
      const key = await authManager.getCurrentApiKey();
      expect(key).toBeNull();
    });

    it('should return API key when set', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

      const key = await authManager.getCurrentApiKey();
      expect(key).toBe('sk-ant-test-key');
    });

    it('should return OAuth token when set', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';

      const key = await authManager.getCurrentApiKey();
      expect(key).toBe('oauth-test-token');
    });

    it('should prefer OAuth token over API key for getCurrentApiKey', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';

      const key = await authManager.getCurrentApiKey();
      expect(key).toBe('oauth-test-token');
    });

    it('should return ANTHROPIC_AUTH_TOKEN when only that is set', async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-test-token';

      const key = await authManager.getCurrentApiKey();
      expect(key).toBe('bearer-test-token');
    });

    it('should prefer OAuth token over ANTHROPIC_AUTH_TOKEN for getCurrentApiKey', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token';
      process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-test-token';

      const key = await authManager.getCurrentApiKey();
      expect(key).toBe('oauth-test-token');
    });
  });

  describe('constructor options', () => {
    it('should accept optional database parameter', () => {
      const manager = new AuthManager(null as unknown);
      expect(manager).toBeDefined();
    });

    it('should accept optional config parameter', () => {
      const manager = new AuthManager(null as unknown, null as unknown);
      expect(manager).toBeDefined();
    });

    it('should accept optional envPath parameter', () => {
      const manager = new AuthManager(undefined, undefined, '/custom/path/.env');
      expect(manager).toBeDefined();
    });
  });
});
