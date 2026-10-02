import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Database } from '../../storage/database.ts';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import { neoPrompt } from './prompt.ts';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function neoCoordinatorRuntimePath(sessionId: string): string {
  return join(tmpdir(), 'hyperneo-neo-context', sessionId.replace(/[^a-zA-Z0-9-]/g, '-'));
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

export function neoCoordinatorNativeTools(concernId: string | null): 'AskUserQuestion'[] {
  return concernId ? ['AskUserQuestion'] : [];
}

export function restrictNeoQuery(
  options: Options,
  concernId: string | null = null,
  sessionId?: string
): void {
  if (sessionId) {
    options.cwd = neoCoordinatorRuntimePath(sessionId);
    mkdirSync(options.cwd, { recursive: true });
  }
  options.systemPrompt = {
    type: 'custom',
    prompt: neoPrompt(concernId),
    snapshot: false,
  };
  const operations = options.mcpServers?.[OPERATIONS_MCP_SERVER_NAME];
  const nativeTools = neoCoordinatorNativeTools(concernId);
  options.tools = nativeTools;
  options.agents = {};
  delete options.agent;
  options.plugins = [];
  options.settingSources = [];
  options.mcpServers = operations ? { [OPERATIONS_MCP_SERVER_NAME]: operations } : {};
  options.allowedTools = [...nativeTools, `mcp__${OPERATIONS_MCP_SERVER_NAME}__invoke`];
}
