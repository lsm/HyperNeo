/**
 * Tools RPC Handlers
 *
 * Provides RPC methods for managing tools (MCP and built-in).
 * Allows clients to:
 * - Save tools configuration with SDK restart
 * - Enable/disable specific MCP tools per session
 * - Query available MCP servers
 * - Get/set global tools configuration
 */

import type { MessageHub, ToolsConfig, GlobalToolsConfig } from '@neokai/shared';
import type { SessionManager } from '../session-manager';
import type { AppMcpLifecycleManager } from '../mcp';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function registerMcpHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  appMcpManager: AppMcpLifecycleManager
): void {
  /**
   * Save tools configuration for a session
   *
   * This is a blocking operation that:
   * 1. Updates session config in memory and DB
   * 2. Restarts the SDK query to apply changes
   * 3. Returns success/failure status
   *
   * Timeout: 30 seconds
   */
  messageHub.onRequest('tools.save', async (data: { sessionId: string; tools: ToolsConfig }) => {
    const { sessionId, tools } = data;

    const agentSession = sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Call the agent session's updateToolsConfig method
    // This handles stopping the query, updating config, and restarting
    const result = await agentSession.updateToolsConfig(tools);

    return result;
  });

  /**
   * List available MCP servers from .mcp.json
   */
  messageHub.onRequest('mcp.listServers', async (data: { sessionId: string }) => {
    const { sessionId } = data;

    const agentSession = sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const session = agentSession.getSessionData();
    const workspacePath = session.worktree?.worktreePath ?? session.workspacePath;
    if (!workspacePath) {
      throw new Error(`Session ${sessionId} has no bound workspace path`);
    }
    const mcpConfigPath = join(workspacePath, '.mcp.json');

    try {
      const content = await readFile(mcpConfigPath, 'utf-8');
      const config = JSON.parse(content) as {
        mcpServers: Record<string, unknown>;
      };
      return {
        servers: config.mcpServers || {},
      };
    } catch {
      // .mcp.json doesn't exist or is invalid
      return {
        servers: {},
      };
    }
  });

  // ============================================================================
  // Global Tools Configuration
  // ============================================================================

  /**
   * Get the global tools configuration
   */
  messageHub.onRequest('globalTools.getConfig', async () => {
    const config = sessionManager.getGlobalToolsConfig();
    return { config };
  });

  /**
   * Save the global tools configuration
   */
  messageHub.onRequest('globalTools.saveConfig', async (data: { config: GlobalToolsConfig }) => {
    sessionManager.saveGlobalToolsConfig(data.config);
  });

  // ============================================================================
  // Application-level MCP Registry
  // ============================================================================

  /**
   * List registry entries that failed validation (missing required fields, etc.).
   * The UI uses this to render a warning badge next to misconfigured entries.
   */
  messageHub.onRequest('mcp.registry.listErrors', async () => {
    return appMcpManager.getStartupErrors();
  });
}
