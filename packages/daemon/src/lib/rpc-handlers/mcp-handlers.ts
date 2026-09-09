import type { MessageHub, ToolsConfig } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';

export function registerMcpHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
  messageHub.onRequest('tools.save', async (data: { sessionId: string; tools: ToolsConfig }) => {
    const { sessionId, tools } = data;

    const agentSession = sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const result = await agentSession.updateToolsConfig(tools);

    return result;
  });

  messageHub.onRequest('globalTools.getConfig', async () => {
    const config = sessionManager.getGlobalToolsConfig();
    return { config };
  });
}
