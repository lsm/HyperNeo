import type {
  DaemonConfigGetResponse,
  DaemonConfigUpdateRequest,
  DaemonConfigUpdateResponse,
  MessageHub,
} from '@hyperneo/shared';
import { DAEMON_CONFIG_KEY_CATALOG } from '@hyperneo/shared';
import type { DaemonConfigService } from '../daemon-config-service.ts';

export interface DaemonConfigHandlerDeps {
  service: DaemonConfigService;
}

export function setupDaemonConfigHandlers(
  messageHub: MessageHub,
  deps: DaemonConfigHandlerDeps
): void {
  messageHub.onRequest('daemonConfig.get', async (): Promise<DaemonConfigGetResponse> => {
    return { config: deps.service.getConfig(), catalog: DAEMON_CONFIG_KEY_CATALOG };
  });

  messageHub.onRequest(
    'daemonConfig.update',
    async (data: DaemonConfigUpdateRequest): Promise<DaemonConfigUpdateResponse> => {
      return deps.service.updateConfig(data.patch);
    }
  );
}
