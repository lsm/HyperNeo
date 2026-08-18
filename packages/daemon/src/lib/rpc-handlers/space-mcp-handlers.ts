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
import { homedir } from 'node:os';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { SpaceManager } from '../space/managers/space-manager';
import { buildMcpJsonPaths, scanMcpImports } from '../mcp/import-scanner';
import { Logger } from '../logger';

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
  spaceManager: SpaceManager
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

    const workspacePaths: string[] = [];
    if (workspacePath && typeof workspacePath === 'string') {
      workspacePaths.push(workspacePath);
    } else {
      const spaces = await spaceManager.listSpaces(true);
      for (const s of spaces) {
        if (s.workspacePath) workspacePaths.push(s.workspacePath);
      }
    }

    const mcpJsonPaths = buildMcpJsonPaths({
      workspacePaths,
      homeDir: homedir(),
    });

    const result = await scanMcpImports(db.appMcpServers, { mcpJsonPaths });

    if (result.imported > 0 || result.removed > 0) {
      emitChanged(internalEventBus);
    }
    log.info(
      `mcp.imports.refresh: imported=${result.imported} removed=${result.removed} notes=${result.notes.length}`
    );

    return {
      ok: true,
      imported: result.imported,
      removed: result.removed,
      notes: result.notes,
    } satisfies McpImportsRefreshResponse;
  });
}
