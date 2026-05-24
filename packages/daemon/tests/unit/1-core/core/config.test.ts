/**
 * Config Tests
 *
 * Tests for the configuration module.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getConfig } from '../../../../src/config';
import { homedir } from 'os';
import { join } from 'path';

describe('getConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store original environment
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  test('returns default values when no overrides or env vars', () => {
    delete process.env.NEOKAI_PORT;
    delete process.env.HOST;
    delete process.env.DB_PATH;
    delete process.env.DEFAULT_MODEL;
    delete process.env.MAX_TOKENS;
    delete process.env.TEMPERATURE;
    delete process.env.MAX_SESSIONS;
    process.env.NODE_ENV = 'production';

    const config = getConfig();

    expect(config.port).toBe(9283);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dbPath).toBe(join(homedir(), '.neokai', 'data', 'daemon.db'));
    // 'default' maps to Sonnet 4.5 in the SDK
    expect(config.defaultModel).toBe('default');
    expect(config.maxTokens).toBe(8192);
    expect(config.temperature).toBe(1.0);
    expect(config.maxSessions).toBe(10);
    expect(config.nodeEnv).toBe('production');
  });

  test('uses environment variables when set', () => {
    process.env.NEOKAI_PORT = '8080';
    process.env.HOST = '127.0.0.1';
    process.env.DB_PATH = '/custom/path/db.sqlite';
    process.env.DEFAULT_MODEL = 'claude-opus-4-20250514';
    process.env.MAX_TOKENS = '4096';
    process.env.TEMPERATURE = '0.5';
    process.env.MAX_SESSIONS = '20';
    process.env.NODE_ENV = 'production';

    const config = getConfig();

    expect(config.port).toBe(8080);
    expect(config.host).toBe('127.0.0.1');
    expect(config.dbPath).toBe('/custom/path/db.sqlite');
    expect(config.defaultModel).toBe('claude-opus-4-20250514');
    expect(config.maxTokens).toBe(4096);
    expect(config.temperature).toBe(0.5);
    expect(config.maxSessions).toBe(20);
  });

  test('NEOKAI_PORT sets the port', () => {
    process.env.NEOKAI_PORT = '9983';

    const config = getConfig();

    expect(config.port).toBe(9983);
  });

  test('PORT env var is ignored (no longer a fallback)', () => {
    delete process.env.NEOKAI_PORT;
    process.env.PORT = '8080';

    const config = getConfig();

    // Falls back to the default, not PORT=8080
    expect(config.port).toBe(9283);
  });

  test('CLI port override takes precedence over NEOKAI_PORT', () => {
    process.env.NEOKAI_PORT = '7777';

    const config = getConfig({ port: 3000 });

    expect(config.port).toBe(3000);
  });

  test('CLI host override takes precedence over env var', () => {
    process.env.HOST = '127.0.0.1';

    const config = getConfig({ host: 'localhost' });

    expect(config.host).toBe('localhost');
  });

  test('CLI dbPath override takes precedence over env var', () => {
    process.env.DB_PATH = '/env/path/db.sqlite';

    const config = getConfig({ dbPath: '/cli/path/db.sqlite' });

    expect(config.dbPath).toBe('/cli/path/db.sqlite');
  });

  test('CLI workspace override takes precedence over env var', () => {
    process.env.NEOKAI_WORKSPACE_ROOT = '/env/workspace';

    const config = getConfig({ workspaceRoot: '/cli/workspace' });

    expect(config.workspaceRoot).toBe('/cli/workspace');
  });

  test('DB_PATH env var takes precedence over default path', () => {
    process.env.DB_PATH = '/custom/database.db';

    const config = getConfig();

    expect(config.dbPath).toBe('/custom/database.db');
  });

  test('default database path is ~/.neokai/data/daemon.db', () => {
    delete process.env.DB_PATH;
    process.env.NODE_ENV = 'production';

    const config = getConfig();

    expect(config.dbPath).toBe(join(homedir(), '.neokai', 'data', 'daemon.db'));
  });

  test('reads API key from env var', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';

    const config = getConfig();

    expect(config.anthropicApiKey).toBe('sk-test-key');
  });

  test('reads OAuth token from env var', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-123';

    const config = getConfig();

    expect(config.claudeCodeOAuthToken).toBe('oauth-token-123');
  });

  test('reads auth token from env var', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-token-456';

    const config = getConfig();

    expect(config.anthropicAuthToken).toBe('auth-token-456');
  });
});
