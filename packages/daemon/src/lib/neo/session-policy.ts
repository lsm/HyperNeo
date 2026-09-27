import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Database } from '../../storage/database.ts';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { OPERATIONS_MCP_SERVER_NAME } from '../mcp/built-in-servers.ts';
import { neoPrompt } from './prompt.ts';

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

export function restrictNeoQuery(options: Options, concernId: string | null = null): void {
  options.systemPrompt = neoPrompt(concernId);
  const operations = options.mcpServers?.[OPERATIONS_MCP_SERVER_NAME];
  options.tools = ['AskUserQuestion'];
  options.agents = {};
  delete options.agent;
  options.plugins = [];
  options.settingSources = [];
  options.mcpServers = operations ? { [OPERATIONS_MCP_SERVER_NAME]: operations } : {};
  options.allowedTools = ['AskUserQuestion', `mcp__${OPERATIONS_MCP_SERVER_NAME}__invoke`];
}
