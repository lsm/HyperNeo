import type { MessageHub } from '@hyperneo/shared';
import type { HealthStatus } from '@hyperneo/shared';
import type { SessionManager } from '../session-manager.ts';
import { BUILD_METADATA } from '../build-metadata.ts';
const startTime = Date.now();

export function setupSystemHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  migration: () => HealthStatus['dataMigration'] = () => undefined
): void {
  messageHub.onRequest('system.health', async () => {
    const response: HealthStatus = {
      status: 'ok',
      dataMigration: migration(),
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
