import { join } from 'path';
import { getDataDir } from './lib/data-dir';

// Bun automatically loads .env files from the current working directory at startup
// Files loaded: .env, .env.local (later files override earlier)
// No dotenv package needed - this is built into Bun runtime

// Discover credentials from Claude Code storage and ~/.claude/settings.json
// This enriches process.env BEFORE any other code reads it.
// Never overwrites existing env vars (explicit config always wins).
import { discoverCredentials } from './lib/credential-discovery';

// Discover credentials and enrich process.env at module load time
discoverCredentials();

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  anthropicApiKey?: string; // Optional - can use CLAUDE_CODE_OAUTH_TOKEN instead
  claudeCodeOAuthToken?: string; // Long-lived OAuth token
  anthropicAuthToken?: string; // Bearer token for third-party proxies
  defaultModel: string;
  maxTokens: number;
  temperature: number;
  maxSessions: number;
  nodeEnv: string;
  workspaceRoot?: string; // Optional default workspace root (from HYPERNEO_WORKSPACE_ROOT env)
  disableWorktrees?: boolean; // For testing - disables git worktree creation
  disableGoalProcessing?: boolean; // For testing/CI - disables automatic goal processing (tick loop)
  // GitHub integration
  githubWebhookSecret?: string; // Secret for verifying webhook signatures
  githubDefaultFilter?: string; // Default filter config as JSON string
}

export interface ConfigOverrides {
  port?: number;
  host?: string;
  dbPath?: string;
  workspaceRoot?: string;
}

/**
 * Read a `HYPERNEO_<name>` env var.
 */
function hyperneoEnv(name: string): string | undefined {
  return process.env[`HYPERNEO_${name}`];
}

export function getConfig(overrides?: ConfigOverrides): Config {
  const nodeEnv = process.env.NODE_ENV || 'development';

  // Default database path: ~/.hyperneo/data/daemon.db
  // Use --db-path / DB_PATH env var to point to a different database
  // (e.g. per-project isolation or Docker volume mounts).
  const defaultDbPath = join(getDataDir(), 'data', 'daemon.db');

  return {
    port: overrides?.port ?? parseInt(hyperneoEnv('PORT') || '9283'),
    host: overrides?.host ?? (process.env.HOST || '0.0.0.0'),
    dbPath: overrides?.dbPath ?? (process.env.DB_PATH || defaultDbPath),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
    // Use 'default' which maps to Sonnet 4.5 in the SDK
    // This matches the SDK's supportedModels() response
    defaultModel: process.env.DEFAULT_MODEL || 'default',
    maxTokens: parseInt(process.env.MAX_TOKENS || '8192'),
    temperature: parseFloat(process.env.TEMPERATURE || '1.0'),
    maxSessions: parseInt(process.env.MAX_SESSIONS || '10'),
    nodeEnv,
    workspaceRoot: overrides?.workspaceRoot ?? hyperneoEnv('WORKSPACE_ROOT'),
    disableWorktrees: hyperneoEnv('DISABLE_WORKTREES') === '1',
    disableGoalProcessing: hyperneoEnv('DISABLE_GOAL_PROCESSING') === '1',
    // GitHub integration
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    githubDefaultFilter: process.env.GITHUB_DEFAULT_FILTER,
  };
}
