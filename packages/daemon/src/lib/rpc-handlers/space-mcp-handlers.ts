/**
 * Space MCP RPC Handlers
 *
 * Per-space MCP enablement surface backed by the generalized `mcp_enablement`
 * table (scope_type='space'). Exposes:
 *   - space.mcp.list(spaceId)               → Array<SpaceMcpEntry>
 *   - space.mcp.setEnabled(...)             → upsert override row
 *   - space.mcp.clearOverride(...)          → delete override row (inherit default)
 *
 * Takes effect on **newly-created** sessions: `AppMcpLifecycleManager`
 * provides `getEnabledMcpConfigsForSpace(spaceId)` and `TaskAgentManager`
 * uses it at spawn time. Existing live sessions keep their previously-
 * resolved MCP set and are NOT hot-swapped — a fresh task run picks up the
 * change.
 *
 * Each mutation emits `mcp.registry.changed` so any daemon-internal
 * subscribers refresh, and relies on the
 * `McpEnablementRepository` to `reactiveDb.notifyChange('mcp_enablement')`
 * which drives the `mcpEnablement.bySpace` LiveQuery.
 */

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
} from '@neokai/shared';
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
  /**
   * List every registry entry with its resolved per-space enabled state so
   * the space settings UI can render the toggle list in a single round-trip.
   *
   * The resolution is: `enabled = override row if present, else registry default`.
   */
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

  /**
   * Upsert an explicit enabled/disabled override for one (space, server) pair.
   */
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

  /**
   * Remove an explicit override so the server inherits the registry default
   * again for this space. No-op (still returns ok:true) when no override
   * row exists, so the UI can call this idempotently from a "reset" button.
   */
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

  /**
   * Rescan on-disk `.mcp.json` files and reconcile imported registry rows.
   *
   * Scans (in order):
   *   - `~/.claude/.mcp.json`
   *   - `<space.workspacePath>/.mcp.json` for every Space
   *   - `<workspacePath>/.mcp.json` when the request narrows to one workspace
   *
   * Emits `mcp.registry.changed` when any import rows change, so the UI
   * picks up the new set on its next `mcp.registry.list` call.
   */
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
