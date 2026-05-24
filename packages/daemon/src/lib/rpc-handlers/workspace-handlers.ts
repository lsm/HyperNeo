/**
 * Workspace History RPC Handlers
 *
 * Provides backend-persisted workspace path history for the session creation flow.
 * The frontend calls these instead of (or in addition to) localStorage.
 *
 * As of the MCP config unification M2 milestone, `workspace.add` also triggers
 * a `.mcp.json` scan for the newly-added path so that imported registry rows
 * (source='imported') appear without waiting for the next daemon restart.
 */

import { join } from 'path';
import type { MessageHub } from '@neokai/shared';
import type { McpImportService } from '../mcp';
import { Logger } from '../logger';
import { validateWorkspaceDirectory } from '../workspace-path';
import type { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository';

const log = new Logger('workspace-handlers');

export function setupWorkspaceHandlers(
  messageHub: MessageHub,
  workspaceHistoryRepo: WorkspaceHistoryRepository,
  mcpImportService?: McpImportService
): void {
  // Get workspace history
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

  // Add/update workspace in history
  messageHub.onRequest('workspace.add', async (data) => {
    const { path } = data as { path: string };
    if (!path || typeof path !== 'string') {
      throw new Error('path is required');
    }
    const workspacePath = await validateWorkspaceDirectory(path);
    const row = workspaceHistoryRepo.upsert(workspacePath);

    // Trigger a `.mcp.json` import for the newly-added workspace.
    // Errors are logged but never thrown — a malformed `.mcp.json` must not
    // cause the workspace addition itself to fail. The import service also
    // swallows per-file failures internally; this outer catch is defensive.
    if (mcpImportService) {
      try {
        mcpImportService.refreshFromFile(join(workspacePath, '.mcp.json'));
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

  // Remove workspace from history
  messageHub.onRequest('workspace.remove', async (data) => {
    const { path } = data as { path: string };
    if (!path || typeof path !== 'string') {
      throw new Error('path is required');
    }
    const success = workspaceHistoryRepo.remove(path);
    return { success };
  });
}
