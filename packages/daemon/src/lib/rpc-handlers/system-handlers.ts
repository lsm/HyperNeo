import type { MessageHub } from '@hyperneo/shared';
import type { HealthStatus } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';

const VERSION = '0.1.1';
const startTime = Date.now();

export function setupSystemHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
  messageHub.onRequest('system.health', async () => {
    const response: HealthStatus = {
      status: 'ok',
      version: VERSION,
      uptime: Date.now() - startTime,
      sessions: {
        active: sessionManager.getActiveSessions(),
        total: sessionManager.getTotalSessions(),
      },
    };

    return response;
  });
}
