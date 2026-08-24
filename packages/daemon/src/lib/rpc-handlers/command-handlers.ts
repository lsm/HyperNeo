import type { MessageHub } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';

export function setupCommandHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
  messageHub.onRequest('commands.list', async (data) => {
    const { sessionId: targetSessionId } = data as { sessionId: string };
    const agentSession = await sessionManager.getSessionAsync(targetSessionId);

    if (!agentSession) {
      throw new Error('Session not found');
    }

    const commands = await agentSession.getSlashCommands();
    return { commands };
  });
}
