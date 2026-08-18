import type { MessageHub, ToolsConfig, GlobalToolsConfig } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager';
import type { AppMcpLifecycleManager } from '../mcp';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function registerMcpHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  appMcpManager: AppMcpLifecycleManager
): void {
  messageHub.onRequest('tools.save', async (data: { sessionId: string; tools: ToolsConfig }) => {
    const { sessionId, tools } = data;

    const agentSession = sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const result = await agentSession.updateToolsConfig(tools);

    return result;
  });

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
      return {
        servers: {},
      };
    }
  });

  messageHub.onRequest('globalTools.getConfig', async () => {
    const config = sessionManager.getGlobalToolsConfig();
    return { config };
  });

  messageHub.onRequest('globalTools.saveConfig', async (data: { config: GlobalToolsConfig }) => {
    sessionManager.saveGlobalToolsConfig(data.config);
  });

  messageHub.onRequest('mcp.registry.listErrors', async () => {
    return appMcpManager.getStartupErrors();
  });
}
