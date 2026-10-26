import type { MessageHub } from '@hyperneo/shared';
import type { McpImportService } from '../mcp/index.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import { validateWorkspaceDirectory } from '../workspace-path.ts';
import type { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository.ts';

const log = new Logger('workspace-handlers');

export function setupWorkspaceHandlers(
  messageHub: MessageHub,
  workspaceHistoryRepo: WorkspaceHistoryRepository,
  mcpImportService?: McpImportService,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>
): void {
  messageHub.onRequest('workspace.history', async (_data) => {
    return {
      entries: workspaceHistoryRepo.entries(),
    };
  });

  messageHub.onRequest('workspace.add', async (data) => {
    const { path } = data as { path: string };
    if (!path || typeof path !== 'string') {
      throw new Error('path is required');
    }
    const workspacePath = await validateWorkspaceDirectory(path);
    workspaceHistoryRepo.upsert(workspacePath);

    if (mcpImportService) {
      try {
        const result = await mcpImportService.refreshAllForPath(workspacePath);
        if (internalEventBus && (result.added > 0 || result.updated > 0 || result.removed > 0)) {
          internalEventBus.publishAsync('mcp.registry.changed', { sessionId: 'global' });
        }
      } catch (err) {
        log.warn(`[workspace.add] MCP import scan failed for ${workspacePath}:`, err);
      }
    }

    return {
      entry: workspaceHistoryRepo.entries().find((entry) => entry.path === workspacePath)!,
    };
  });

  messageHub.onRequest('workspace.remove', async (data) => {
    const { path } = data as { path: string };
    if (!path || typeof path !== 'string') {
      throw new Error('path is required');
    }
    const success = workspaceHistoryRepo.remove(path);
    return { success };
  });
}
