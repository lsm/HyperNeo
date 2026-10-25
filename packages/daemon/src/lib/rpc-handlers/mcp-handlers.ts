import type { SessionToolPreferenceWriter } from '../tools/write-session-tool-preferences.ts';
import type { MessageHub, ToolsConfig } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';

export function registerMcpHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  writePreferences: SessionToolPreferenceWriter
): void {
  messageHub.onRequest('tools.save', async (data: { sessionId: string; tools: ToolsConfig }) => {
    const { sessionId, tools } = data;

    const agentSession = sessionManager.getSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      const result = await writePreferences(
        sessionId,
        { kind: 'skills', disabledSkills: tools.disabledSkills ?? [] },
        tools
      );
      return result.ok ? { success: true } : { success: false, error: result.reason };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  messageHub.onRequest('globalTools.getConfig', async () => {
    const config = sessionManager.getGlobalToolsConfig();
    return { config };
  });
}
