import type { MessageHub } from '@hyperneo/shared';
import type { HealthStatus } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';
import { BUILD_METADATA } from '../build-metadata.ts';
const startTime = Date.now();

export function setupSystemHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
  messageHub.onRequest('system.health', async () => {
    const response: HealthStatus = {
      status: 'ok',
      version: BUILD_METADATA.version,
      uptime: Date.now() - startTime,
      sessions: {
        active: sessionManager.getActiveSessions(),
        total: sessionManager.getTotalSessions(),
      },
    };

    return response;
  });
}
