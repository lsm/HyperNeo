import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Database } from '../../storage/database.ts';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { getDataDir } from '../data-dir.ts';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import { getSDKProjectDir } from '../sdk-session-file-manager.ts';
import { neoFolderPath } from './folder.ts';
import { NEO_LOOKUP_COMMANDS, neoLookUpGuard, neoSecretReadRules } from './look-up-guard.ts';
import { neoPrompt } from './prompt.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function sdkTranscriptsExist(cwd: string): boolean {
  return [cwd, `/private${cwd}`].some((path) => existsSync(getSDKProjectDir(path)));
}

export function neoCoordinatorRuntimePath(sessionId: string): string {
  const legacy = join(tmpdir(), 'hyperneo-neo-context', sessionId.replace(/[^a-zA-Z0-9-]/g, '-'));
  return sdkTranscriptsExist(legacy)
    ? legacy
    : join(neoFolderPath(), '.coordinators', sessionId.replace(/[^a-zA-Z0-9-]/g, '-'));
}

export function neoCoordinatorBinding(
  db: Database | undefined,
  sessionId: string
): NeoBinding | null {
  if (!sessionId.startsWith('neo:') || !db) return null;
  const row = db
    .getDatabase()
    .prepare(
      "SELECT session_id AS sessionId, concern_id AS concernId, kind FROM neo_session_bindings WHERE session_id = ? AND kind IN ('neo', 'concern')"
    )
    .get(sessionId) as NeoBinding | null;
  return row ?? null;
}

const NEO_LOOKUP_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash'];
export function neoCoordinatorDeniedReads(): string[] {
  return neoSecretReadRules({ dataDir: getDataDir() });
}

export function neoCoordinatorNativeTools(concernId: string | null): string[] {
  return [...(concernId ? ['AskUserQuestion'] : []), ...NEO_LOOKUP_TOOLS];
}

export function neoCoordinatorAllowedTools(concernId: string | null): string[] {
  return [
    ...neoCoordinatorNativeTools(concernId).filter((tool) => tool !== 'Bash'),
    ...NEO_LOOKUP_COMMANDS.map((command) => `Bash(${command}:*)`),
    `mcp__${OPERATIONS_MCP_SERVER_NAME}__invoke`,
  ];
}

export function restrictNeoQuery(
  options: Options,
  concernId: string | null = null,
  sessionId?: string,
  catchUp = ''
): void {
  if (sessionId) {
    options.cwd = neoCoordinatorRuntimePath(sessionId);
    mkdirSync(options.cwd, { recursive: true });
  }
  options.systemPrompt = {
    type: 'custom',
    prompt: catchUp ? `${neoPrompt(concernId)}\n\n${catchUp}` : neoPrompt(concernId),
    snapshot: false,
  };
  const operations = options.mcpServers?.[OPERATIONS_MCP_SERVER_NAME];
  options.tools = neoCoordinatorNativeTools(concernId);
  options.additionalDirectories = [homedir()];
  options.agents = {};
  delete options.agent;
  options.plugins = [];
  options.settingSources = [];
  options.mcpServers = operations ? { [OPERATIONS_MCP_SERVER_NAME]: operations } : {};
  options.allowedTools = neoCoordinatorAllowedTools(concernId);
  options.disallowedTools = [...(options.disallowedTools ?? []), ...neoCoordinatorDeniedReads()];
  options.hooks = {
    ...options.hooks,
    PreToolUse: [
      { hooks: [neoLookUpGuard({ home: homedir(), dataDir: getDataDir() })] },
      ...(options.hooks?.PreToolUse ?? []),
    ],
  };
}
