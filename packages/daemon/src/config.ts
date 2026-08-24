import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT } from '@hyperneo/shared';
import type { SQLiteQueryObservabilityOptions } from './storage/sqlite-query-observability';
import {
  DEFAULT_SQL_QUERY_MAX_QUERY_GROUPS,
  DEFAULT_SQL_QUERY_SLOW_THRESHOLD_MS,
  DEFAULT_SQL_QUERY_SUMMARY_INTERVAL_MS,
  DEFAULT_SQL_QUERY_SUMMARY_LIMIT,
} from './storage/sqlite-query-observability';
import { getDataDir } from './lib/data-dir';

import { discoverCredentials } from './lib/credential-discovery';

discoverCredentials();

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  anthropicApiKey?: string;
  claudeCodeOAuthToken?: string;
  anthropicAuthToken?: string;
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  maxSessions: number;
  maxSubscriptionsPerClient: number;
  nodeEnv: string;
  workspaceRoot?: string;
  disableWorktrees?: boolean;
  disableGoalProcessing?: boolean;
  githubWebhookSecret?: string;
  githubDefaultFilter?: string;
  structuredLogFilePath?: string;
  structuredLogMaxBytes: number;
  structuredLogRetainedFiles: number;
  structuredLogMaxPendingBytes: number;
  sqlQueryObservability?: SQLiteQueryObservabilityOptions;
}

export interface ConfigOverrides {
  port?: number;
  host?: string;
  dbPath?: string;
  workspaceRoot?: string;
  structuredLogFilePath?: string | null;
  structuredLogMaxBytes?: number;
  structuredLogRetainedFiles?: number;
  structuredLogMaxPendingBytes?: number;
}

function hyperneoEnv(name: string): string | undefined {
  return process.env[`HYPERNEO_${name}`];
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) return fallback;
  const parsed = parseInt(raw, 10);
  return parsed > 0 && Number.isSafeInteger(parsed) ? parsed : fallback;
}

function positiveOverride(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isExplicitlyDisabled(raw: string | undefined): boolean {
  return ['0', 'false', 'off'].includes((raw ?? '').trim().toLowerCase());
}

export function getConfig(overrides?: ConfigOverrides): Config {
  const nodeEnv = process.env.NODE_ENV || 'development';

  const defaultDbPath = join(getDataDir(), 'data', 'daemon.db');
  const configuredLogPath = hyperneoEnv('LOG_FILE');
  const normalizedLogPath = configuredLogPath?.trim();
  const resolvedDbPath = overrides?.dbPath ?? process.env.DB_PATH ?? defaultDbPath;
  const isMemoryDb = resolvedDbPath === ':memory:';
  const absoluteDbPath = isMemoryDb ? resolvedDbPath : resolve(resolvedDbPath);
  const customDbIsolatable = absoluteDbPath !== defaultDbPath && dirname(absoluteDbPath) !== '.';
  const dbLogComponent = (customDbIsolatable && basename(absoluteDbPath)) || 'daemon';
  const defaultLogPath =
    nodeEnv === 'test'
      ? undefined
      : customDbIsolatable
        ? join(dirname(absoluteDbPath), 'logs', `${dbLogComponent}.jsonl`)
        : join(getDataDir(), 'logs', 'daemon.jsonl');
  const structuredLogFilePath =
    overrides?.structuredLogFilePath === null
      ? undefined
      : (overrides?.structuredLogFilePath ??
        (normalizedLogPath === '0' || normalizedLogPath?.toLowerCase() === 'off'
          ? undefined
          : normalizedLogPath || defaultLogPath));
  const defaultLogMaxBytes = 10 * 1024 * 1024;
  const defaultLogRetainedFiles = 5;
  const defaultLogMaxPendingBytes = 2 * 1024 * 1024;
  const sqlQueryObservabilityExplicit = hyperneoEnv('SQL_QUERY_OBSERVABILITY');
  const sqlQueryObservabilityEnabled = sqlQueryObservabilityExplicit
    ? !isExplicitlyDisabled(sqlQueryObservabilityExplicit)
    : nodeEnv !== 'test';

  return {
    port: overrides?.port ?? parseInt(hyperneoEnv('PORT') || '9283', 10),
    host: overrides?.host ?? (process.env.HOST || '0.0.0.0'),
    dbPath: overrides?.dbPath ?? (process.env.DB_PATH || defaultDbPath),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
    defaultModel: process.env.DEFAULT_MODEL || 'default',
    maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
    temperature: parseFloat(process.env.TEMPERATURE || '1.0'),
    maxSessions: parseInt(process.env.MAX_SESSIONS || '10', 10),
    maxSubscriptionsPerClient: parsePositiveInt(
      hyperneoEnv('MAX_SUBSCRIPTIONS_PER_CLIENT'),
      DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT
    ),
    nodeEnv,
    workspaceRoot: overrides?.workspaceRoot ?? hyperneoEnv('WORKSPACE_ROOT'),
    disableWorktrees: hyperneoEnv('DISABLE_WORKTREES') === '1',
    disableGoalProcessing: hyperneoEnv('DISABLE_GOAL_PROCESSING') === '1',
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    githubDefaultFilter: process.env.GITHUB_DEFAULT_FILTER,
    structuredLogFilePath,
    structuredLogMaxBytes: positiveOverride(
      overrides?.structuredLogMaxBytes,
      parsePositiveInt(hyperneoEnv('LOG_MAX_BYTES'), defaultLogMaxBytes)
    ),
    structuredLogRetainedFiles: Math.min(
      positiveOverride(
        overrides?.structuredLogRetainedFiles,
        parsePositiveInt(hyperneoEnv('LOG_RETAINED_FILES'), defaultLogRetainedFiles)
      ),
      1_000
    ),
    structuredLogMaxPendingBytes: positiveOverride(
      overrides?.structuredLogMaxPendingBytes,
      parsePositiveInt(hyperneoEnv('LOG_MAX_PENDING_BYTES'), defaultLogMaxPendingBytes)
    ),
    ...(sqlQueryObservabilityEnabled
      ? {
          sqlQueryObservability: {
            slowThresholdMs: parsePositiveInt(
              hyperneoEnv('SQL_QUERY_SLOW_THRESHOLD_MS'),
              DEFAULT_SQL_QUERY_SLOW_THRESHOLD_MS
            ),
            summaryIntervalMs: parsePositiveInt(
              hyperneoEnv('SQL_QUERY_SUMMARY_INTERVAL_MS'),
              DEFAULT_SQL_QUERY_SUMMARY_INTERVAL_MS
            ),
            maxQueryGroups: parsePositiveInt(
              hyperneoEnv('SQL_QUERY_MAX_QUERY_GROUPS'),
              DEFAULT_SQL_QUERY_MAX_QUERY_GROUPS
            ),
            summaryQueryLimit: parsePositiveInt(
              hyperneoEnv('SQL_QUERY_SUMMARY_LIMIT'),
              DEFAULT_SQL_QUERY_SUMMARY_LIMIT
            ),
          } satisfies SQLiteQueryObservabilityOptions,
        }
      : {}),
  };
}
