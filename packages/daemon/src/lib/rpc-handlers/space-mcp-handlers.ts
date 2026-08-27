import type {
  MessageHub,
  SpaceMcpEntry,
  SpaceMcpListRequest,
  SpaceMcpListResponse,
  SpaceMcpSetEnabledRequest,
  SpaceMcpSetEnabledResponse,
  SpaceMcpClearOverrideRequest,
  SpaceMcpClearOverrideResponse,
  McpImportsRefreshRequest,
  McpImportsRefreshResponse,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Database } from '../../storage/database.ts';
import type { SpaceManager } from '../space/managers/space-manager.ts';
import { resolve } from 'node:path';
import type { ImportResult, McpImportService } from '../mcp/index.ts';
import { Logger } from '../logger.ts';

const log = new Logger('space-mcp-handlers');

function emitChanged(internalEventBus: InternalEventBus<DaemonInternalEventMap>): void {
  internalEventBus.publish('mcp.registry.changed', { sessionId: 'global' }).catch((err) => {
    log.warn('Failed to emit mcp.registry.changed:', err);
  });
}

async function assertSpaceExists(spaceManager: SpaceManager, spaceId: string): Promise<void> {
  const space = await spaceManager.getSpace(spaceId);
  if (!space) {
    throw new Error(`Space not found: ${spaceId}`);
  }
}

export function setupSpaceMcpHandlers(
  messageHub: MessageHub,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  db: Database,
  spaceManager: SpaceManager,
  mcpImportService?: McpImportService
): void {
  messageHub.onRequest('space.mcp.list', async (data) => {
    const { spaceId } = data as SpaceMcpListRequest;
    if (!spaceId || typeof spaceId !== 'string') {
      throw new Error('spaceId is required');
    }
    await assertSpaceExists(spaceManager, spaceId);

    const servers = db.appMcpServers.list();
    const overrides = db.mcpEnablement.listForScope('space', spaceId);
    const overrideMap = new Map(overrides.map((o) => [o.serverId, o.enabled]));

    const entries: SpaceMcpEntry[] = servers.map((server) => {
      const override = overrideMap.get(server.id);
      const overridden = override !== undefined;
      const enabled = overridden ? override! : server.enabled;
      return {
        serverId: server.id,
        name: server.name,
        ...(server.description !== undefined ? { description: server.description } : {}),
        sourceType: server.sourceType,
        source: server.source,
        ...(server.sourcePath !== undefined ? { sourcePath: server.sourcePath } : {}),
        globallyEnabled: server.enabled,
        overridden,
        enabled,
      };
    });

    return { entries } satisfies SpaceMcpListResponse;
  });

  messageHub.onRequest('space.mcp.setEnabled', async (data) => {
    const { spaceId, serverId, enabled } = data as SpaceMcpSetEnabledRequest;
    if (!spaceId || typeof spaceId !== 'string') {
      throw new Error('spaceId is required');
    }
    if (!serverId || typeof serverId !== 'string') {
      throw new Error('serverId is required');
    }
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }
    await assertSpaceExists(spaceManager, spaceId);

    const server = db.appMcpServers.get(serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }

    db.mcpEnablement.setOverride('space', spaceId, serverId, enabled);
    emitChanged(internalEventBus);
    log.info(
      `space.mcp.setEnabled: space=${spaceId} server=${serverId} (${server.name}) enabled=${enabled}`
    );
    return { ok: true } satisfies SpaceMcpSetEnabledResponse;
  });

  messageHub.onRequest('space.mcp.clearOverride', async (data) => {
    const { spaceId, serverId } = data as SpaceMcpClearOverrideRequest;
    if (!spaceId || typeof spaceId !== 'string') {
      throw new Error('spaceId is required');
    }
    if (!serverId || typeof serverId !== 'string') {
      throw new Error('serverId is required');
    }
    await assertSpaceExists(spaceManager, spaceId);

    const cleared = db.mcpEnablement.clearOverride('space', spaceId, serverId);
    if (cleared) {
      emitChanged(internalEventBus);
      log.info(`space.mcp.clearOverride: space=${spaceId} server=${serverId}`);
    }
    return { ok: true } satisfies SpaceMcpClearOverrideResponse;
  });

  messageHub.onRequest('mcp.imports.refresh', async (data) => {
    const { workspacePath } = (data ?? {}) as McpImportsRefreshRequest;
    const notes: string[] = [];
    let added = 0;
    let updated = 0;
    let removed = 0;

    if (!mcpImportService) {
      return { ok: true, imported: 0, removed: 0, notes } satisfies McpImportsRefreshResponse;
    }

    if (workspacePath && typeof workspacePath === 'string') {
      const result: ImportResult = mcpImportService.refreshAllForPath(resolve(workspacePath));
      added = result.added;
      updated = result.updated;
      removed = result.removed;
      if (result.status === 'malformed') {
        notes.push(`${result.sourcePath}: parse error — ${result.error ?? 'invalid file'}`);
      } else if (result.status === 'failed') {
        notes.push(`${result.sourcePath}: import failed — ${result.error ?? 'unknown error'}`);
      }
    } else {
      const result = mcpImportService.refreshAll();
      for (const r of result.results) {
        if (r.status === 'malformed') {
          notes.push(`${r.sourcePath}: parse error — ${r.error ?? 'invalid file'}`);
        } else if (r.status === 'failed') {
          notes.push(`${r.sourcePath}: import failed — ${r.error ?? 'unknown error'}`);
        }
      }
      added = result.results.reduce((sum, r) => sum + r.added, 0);
      updated = result.results.reduce((sum, r) => sum + r.updated, 0);
      removed = result.results.reduce((sum, r) => sum + r.removed, 0) + result.orphanPruned;
    }

    if (added > 0 || updated > 0 || removed > 0) {
      emitChanged(internalEventBus);
    }
    log.info(`mcp.imports.refresh: imported=${added} removed=${removed} notes=${notes.length}`);

    return {
      ok: true,
      imported: added + updated,
      removed,
      notes,
    } satisfies McpImportsRefreshResponse;
  });
}
