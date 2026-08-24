import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfig, parsePositiveInt } from '../../../../src/config';

describe('getConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns default values when no overrides or env vars', () => {
    delete process.env.HYPERNEO_PORT;
    delete process.env.HOST;
    delete process.env.DB_PATH;
    delete process.env.DEFAULT_MODEL;
    delete process.env.MAX_TOKENS;
    delete process.env.TEMPERATURE;
    delete process.env.MAX_SESSIONS;
    delete process.env.HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT;
    delete process.env.HYPERNEO_LOG_FILE;
    delete process.env.HYPERNEO_LOG_MAX_BYTES;
    delete process.env.HYPERNEO_LOG_RETAINED_FILES;
    delete process.env.HYPERNEO_LOG_MAX_PENDING_BYTES;
    process.env.NODE_ENV = 'production';

    const config = getConfig();

    expect(config.port).toBe(9283);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dbPath).toBe(join(homedir(), '.hyperneo', 'data', 'daemon.db'));
    expect(config.defaultModel).toBe('default');
    expect(config.maxTokens).toBe(8192);
    expect(config.temperature).toBe(1.0);
    expect(config.maxSessions).toBe(10);
    expect(config.maxSubscriptionsPerClient).toBe(128);
    expect(config.nodeEnv).toBe('production');
    expect(config.structuredLogFilePath).toBe(join(homedir(), '.hyperneo', 'logs', 'daemon.jsonl'));
    expect(config.structuredLogMaxBytes).toBe(10 * 1024 * 1024);
    expect(config.structuredLogRetainedFiles).toBe(5);
    expect(config.structuredLogMaxPendingBytes).toBe(2 * 1024 * 1024);
  });

  test('uses environment variables when set', () => {
    process.env.HYPERNEO_PORT = '8080';
    process.env.HOST = '127.0.0.1';
    process.env.DB_PATH = '/custom/path/db.sqlite';
    process.env.DEFAULT_MODEL = 'claude-opus-4-20250514';
    process.env.MAX_TOKENS = '4096';
    process.env.TEMPERATURE = '0.5';
    process.env.MAX_SESSIONS = '20';
    process.env.HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT = '256';
    process.env.NODE_ENV = 'production';

    const config = getConfig();

    expect(config.port).toBe(8080);
    expect(config.host).toBe('127.0.0.1');
    expect(config.dbPath).toBe('/custom/path/db.sqlite');
    expect(config.defaultModel).toBe('claude-opus-4-20250514');
    expect(config.maxTokens).toBe(4096);
    expect(config.temperature).toBe(0.5);
    expect(config.maxSessions).toBe(20);
    expect(config.maxSubscriptionsPerClient).toBe(256);
  });

  test('HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT fails closed to the default on invalid input', () => {
    process.env.HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT = 'not-a-number';
    expect(getConfig().maxSubscriptionsPerClient).toBe(128);

    process.env.HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT = '0';
    expect(getConfig().maxSubscriptionsPerClient).toBe(128);

    process.env.HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT = '-5';
    expect(getConfig().maxSubscriptionsPerClient).toBe(128);

    process.env.HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT = '1000000oops';
    expect(getConfig().maxSubscriptionsPerClient).toBe(128);

    process.env.HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT = '1e3';
    expect(getConfig().maxSubscriptionsPerClient).toBe(128);

    process.env.HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT = '12.5';
    expect(getConfig().maxSubscriptionsPerClient).toBe(128);
  });

  test('configures and disables structured file logging', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.HYPERNEO_LOG_FILE;
    expect(getConfig().structuredLogFilePath).toBeUndefined();

    process.env.HYPERNEO_LOG_FILE = '/tmp/hyperneo-daemon.jsonl';
    process.env.HYPERNEO_LOG_MAX_BYTES = '1234';
    process.env.HYPERNEO_LOG_RETAINED_FILES = '3';
    process.env.HYPERNEO_LOG_MAX_PENDING_BYTES = '5678';
    expect(getConfig()).toMatchObject({
      structuredLogFilePath: '/tmp/hyperneo-daemon.jsonl',
      structuredLogMaxBytes: 1234,
      structuredLogRetainedFiles: 3,
      structuredLogMaxPendingBytes: 5678,
    });

    process.env.HYPERNEO_LOG_FILE = 'OFF';
    expect(getConfig().structuredLogFilePath).toBeUndefined();
  });

  test('structured log overrides take precedence and invalid bounds fail closed', () => {
    process.env.HYPERNEO_LOG_FILE = '/env/log.jsonl';
    process.env.HYPERNEO_LOG_MAX_BYTES = 'invalid';
    process.env.HYPERNEO_LOG_RETAINED_FILES = '0';
    process.env.HYPERNEO_LOG_MAX_PENDING_BYTES = '-1';

    expect(
      getConfig({
        structuredLogFilePath: '/override/log.jsonl',
        structuredLogMaxBytes: 2048,
        structuredLogRetainedFiles: 2,
        structuredLogMaxPendingBytes: 4096,
      })
    ).toMatchObject({
      structuredLogFilePath: '/override/log.jsonl',
      structuredLogMaxBytes: 2048,
      structuredLogRetainedFiles: 2,
      structuredLogMaxPendingBytes: 4096,
    });

    expect(
      getConfig({
        structuredLogFilePath: null,
        structuredLogMaxBytes: 0,
        structuredLogRetainedFiles: -1,
        structuredLogMaxPendingBytes: Number.NaN,
      })
    ).toMatchObject({
      structuredLogFilePath: undefined,
      structuredLogMaxBytes: 10 * 1024 * 1024,
      structuredLogRetainedFiles: 5,
      structuredLogMaxPendingBytes: 2 * 1024 * 1024,
    });
  });

  test('HYPERNEO_PORT sets the port', () => {
    process.env.HYPERNEO_PORT = '9983';

    const config = getConfig();

    expect(config.port).toBe(9983);
  });

  test('PORT env var is ignored (no longer a fallback)', () => {
    delete process.env.HYPERNEO_PORT;
    process.env.PORT = '8080';

    const config = getConfig();

    expect(config.port).toBe(9283);
  });

  test('CLI port override takes precedence over HYPERNEO_PORT', () => {
    process.env.HYPERNEO_PORT = '7777';

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
    process.env.HYPERNEO_WORKSPACE_ROOT = '/env/workspace';

    const config = getConfig({ workspaceRoot: '/cli/workspace' });

    expect(config.workspaceRoot).toBe('/cli/workspace');
  });

  test('DB_PATH env var takes precedence over default path', () => {
    process.env.DB_PATH = '/custom/database.db';

    const config = getConfig();

    expect(config.dbPath).toBe('/custom/database.db');
  });

  test('isolated DB files derive distinct per-database log paths', () => {
    process.env.NODE_ENV = 'production';

    process.env.DB_PATH = '/tmp/hyperneo-worktree-a.db';
    const a = getConfig().structuredLogFilePath;
    process.env.DB_PATH = '/tmp/hyperneo-worktree-b.db';
    const b = getConfig().structuredLogFilePath;

    expect(a).toBe('/tmp/logs/hyperneo-worktree-a.db.jsonl');
    expect(b).toBe('/tmp/logs/hyperneo-worktree-b.db.jsonl');
    expect(a).not.toBe(b);
  });

  test('same-stem DBs with different extensions derive distinct log paths', () => {
    process.env.NODE_ENV = 'production';

    process.env.DB_PATH = '/tmp/hyperneo.db';
    const a = getConfig().structuredLogFilePath;
    process.env.DB_PATH = '/tmp/hyperneo.sqlite';
    const b = getConfig().structuredLogFilePath;

    expect(a).toBe('/tmp/logs/hyperneo.db.jsonl');
    expect(b).toBe('/tmp/logs/hyperneo.sqlite.jsonl');
    expect(a).not.toBe(b);
  });

  test('relative custom DB paths derive distinct per-database log paths', () => {
    process.env.NODE_ENV = 'production';

    process.env.DB_PATH = 'worktree-a.db';
    const a = getConfig().structuredLogFilePath;
    process.env.DB_PATH = 'worktree-b.db';
    const b = getConfig().structuredLogFilePath;

    expect(a).toBe(join(process.cwd(), 'logs', 'worktree-a.db.jsonl'));
    expect(b).toBe(join(process.cwd(), 'logs', 'worktree-b.db.jsonl'));
    expect(a).not.toBe(b);
  });

  test('structured log retained-file overrides are capped like the env fallback', () => {
    process.env.NODE_ENV = 'production';

    const config = getConfig({ structuredLogRetainedFiles: Number.MAX_SAFE_INTEGER });

    expect(config.structuredLogRetainedFiles).toBe(1_000);
  });

  test('default database path is ~/.hyperneo/data/daemon.db', () => {
    delete process.env.DB_PATH;
    process.env.NODE_ENV = 'production';

    const config = getConfig();

    expect(config.dbPath).toBe(join(homedir(), '.hyperneo', 'data', 'daemon.db'));
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

  test('sql query observability defaults on outside tests and off in test env', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.HYPERNEO_SQL_QUERY_OBSERVABILITY;
    delete process.env.HYPERNEO_SQL_QUERY_SLOW_THRESHOLD_MS;
    delete process.env.HYPERNEO_SQL_QUERY_SUMMARY_INTERVAL_MS;
    delete process.env.HYPERNEO_SQL_QUERY_MAX_QUERY_GROUPS;
    delete process.env.HYPERNEO_SQL_QUERY_SUMMARY_LIMIT;
    expect(getConfig().sqlQueryObservability).toEqual({
      slowThresholdMs: 250,
      summaryIntervalMs: 300_000,
      maxQueryGroups: 500,
      summaryQueryLimit: 10,
    });

    process.env.NODE_ENV = 'test';
    expect(getConfig().sqlQueryObservability).toBeUndefined();

    process.env.HYPERNEO_SQL_QUERY_OBSERVABILITY = '1';
    expect(getConfig().sqlQueryObservability).toBeDefined();
  });

  test('sql query observability env tuning, disabling, and invalid fallbacks', () => {
    process.env.NODE_ENV = 'production';
    process.env.HYPERNEO_SQL_QUERY_OBSERVABILITY = '0';
    expect(getConfig().sqlQueryObservability).toBeUndefined();

    process.env.HYPERNEO_SQL_QUERY_OBSERVABILITY = 'false';
    expect(getConfig().sqlQueryObservability).toBeUndefined();

    process.env.HYPERNEO_SQL_QUERY_OBSERVABILITY = 'on';
    process.env.HYPERNEO_SQL_QUERY_SLOW_THRESHOLD_MS = '100';
    process.env.HYPERNEO_SQL_QUERY_SUMMARY_INTERVAL_MS = '60000';
    process.env.HYPERNEO_SQL_QUERY_MAX_QUERY_GROUPS = '25';
    process.env.HYPERNEO_SQL_QUERY_SUMMARY_LIMIT = '3';
    expect(getConfig().sqlQueryObservability).toEqual({
      slowThresholdMs: 100,
      summaryIntervalMs: 60_000,
      maxQueryGroups: 25,
      summaryQueryLimit: 3,
    });

    process.env.HYPERNEO_SQL_QUERY_SLOW_THRESHOLD_MS = 'not-a-number';
    process.env.HYPERNEO_SQL_QUERY_SUMMARY_INTERVAL_MS = '0';
    expect(getConfig().sqlQueryObservability).toEqual({
      slowThresholdMs: 250,
      summaryIntervalMs: 300_000,
      maxQueryGroups: 25,
      summaryQueryLimit: 3,
    });
  });
});

describe('parsePositiveInt', () => {
  test('rejects negative, fractional, and partial-numeric values', () => {
    expect(parsePositiveInt('-5', 64)).toBe(64);
    expect(parsePositiveInt('1.5', 64)).toBe(64);
    expect(parsePositiveInt('0', 64)).toBe(64);
    expect(parsePositiveInt('abc', 64)).toBe(64);
    expect(parsePositiveInt('1000000oops', 64)).toBe(64);
    expect(parsePositiveInt(undefined, 64)).toBe(64);
    expect(parsePositiveInt('64', 64)).toBe(64);
    expect(parsePositiveInt(' 8 ', 8)).toBe(8);
    expect(parsePositiveInt('9'.repeat(400), 64)).toBe(64);
    expect(parsePositiveInt('100000000000000000000', 64)).toBe(64);
  });
});
