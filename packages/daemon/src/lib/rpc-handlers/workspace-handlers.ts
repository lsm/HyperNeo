import { join } from 'path';
import type { MessageHub } from '@hyperneo/shared';
import type { McpImportService } from '../mcp';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { Logger } from '../logger';
import { validateWorkspaceDirectory } from '../workspace-path';
import type { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository';

const log = new Logger('workspace-handlers');

export function setupWorkspaceHandlers(
  messageHub: MessageHub,
  workspaceHistoryRepo: WorkspaceHistoryRepository,
  mcpImportService?: McpImportService,
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>
): void {
  messageHub.onRequest('workspace.history', async (_data) => {
    const rows = workspaceHistoryRepo.list(20);
    return {
      entries: rows.map((r) => ({
        path: r.path,
        lastUsedAt: r.last_used_at,
        useCount: r.use_count,
      })),
    };
  });

  messageHub.onRequest('workspace.add', async (data) => {
    const { path } = data as { path: string };
    if (!path || typeof path !== 'string') {
      throw new Error('path is required');
    }
    const workspacePath = await validateWorkspaceDirectory(path);
    const row = workspaceHistoryRepo.upsert(workspacePath);

    if (mcpImportService) {
      try {
        const result = mcpImportService.refreshFromFile(join(workspacePath, '.mcp.json'));
        if (internalEventBus && (result.added > 0 || result.updated > 0 || result.removed > 0)) {
          internalEventBus.publishAsync('mcp.registry.changed', { sessionId: 'global' });
        }
      } catch (err) {
        log.warn(`[workspace.add] MCP import scan failed for ${workspacePath}:`, err);
      }
    }

    return {
      entry: {
        path: row.path,
        lastUsedAt: row.last_used_at,
        useCount: row.use_count,
      },
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
