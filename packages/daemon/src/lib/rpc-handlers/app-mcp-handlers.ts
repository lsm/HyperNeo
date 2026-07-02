/**
 * App MCP RPC Handlers
 *
 * Contains two sets of handlers:
 *
 * 1. App MCP Registry RPC Handlers (registerAppMcpHandlers)
 *    Exposes the application-level MCP server registry via RPC:
 *    - mcp.registry.list       — list all registry entries
 *    - mcp.registry.get        — get a single entry by id
 *    - mcp.registry.create     — add a new entry, emit mcp.registry.changed
 *    - mcp.registry.update     — update an entry, emit mcp.registry.changed
 *    - mcp.registry.delete     — remove an entry, emit mcp.registry.changed
 *    - mcp.registry.setEnabled — toggle enabled flag, emit mcp.registry.changed
 *
 *    Note: mcp.registry.listErrors is registered in mcp-handlers.ts (requires
 *    the concrete AppMcpLifecycleManager).
 *
 * 2. Scope-aware MCP enablement RPC handlers (setupAppMcpHandlers)
 *    Provides the active `mcp.enablement.*` and `session.mcp.*` methods.
 *    Legacy room-scope rows remain in `mcp_enablement` for old DB compatibility,
 *    but the historical `mcp.room.*` public API is no longer registered.
 */

import type { MessageHub } from '@hyperneo/shared';
import type {
  AppMcpServer,
  CreateAppMcpServerRequest,
  McpEffectiveEnablementSource,
  McpEnablementOverride,
  SessionMcpListRequest,
  SessionMcpListResponse,
  SessionMcpServerEntry,
  UpdateAppMcpServerRequest,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import type { Database } from '../../storage/database';
import type {
  McpEnablementClearOverrideRequest,
  McpEnablementClearOverrideResponse,
  McpEnablementClearScopeRequest,
  McpEnablementClearScopeResponse,
  McpEnablementListRequest,
  McpEnablementListResponse,
  McpEnablementSetOverrideRequest,
  McpEnablementSetOverrideResponse,
} from '@hyperneo/shared';
import { scopeChainForSession } from '../mcp/resolve-mcp-servers';
import { Logger } from '../logger';

const log = new Logger('app-mcp-handlers');

// ---------------------------------------------------------------------------
// Registry handler context
// ---------------------------------------------------------------------------

export interface AppMcpHandlerContext {
  db: { appMcpServers: AppMcpServerRepository };
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitChanged(internalEventBus: InternalEventBus<DaemonInternalEventMap>): void {
  internalEventBus.publish('mcp.registry.changed', { sessionId: 'global' }).catch((err) => {
    log.warn('Failed to emit mcp.registry.changed:', err);
  });
}

// ---------------------------------------------------------------------------
// Registry handler registration
// ---------------------------------------------------------------------------

export function registerAppMcpHandlers(messageHub: MessageHub, ctx: AppMcpHandlerContext): void {
  const { db, internalEventBus } = ctx;

  // mcp.registry.list — returns AppMcpServer[]
  messageHub.onRequest('mcp.registry.list', async () => {
    const servers = db.appMcpServers.list();
    return { servers } satisfies { servers: AppMcpServer[] };
  });

  // mcp.registry.get — fetch a single entry by id
  messageHub.onRequest('mcp.registry.get', async (data) => {
    const { id } = data as { id: string };

    if (!id) {
      throw new Error('id is required');
    }

    const server = db.appMcpServers.get(id);
    if (!server) {
      throw new Error(`MCP server not found: ${id}`);
    }

    return { server } satisfies { server: AppMcpServer };
  });

  // mcp.registry.create — validates input, creates entry, emits event
  messageHub.onRequest('mcp.registry.create', async (data) => {
    const params = data as CreateAppMcpServerRequest;

    if (!params.name || params.name.trim() === '') {
      throw new Error('name is required');
    }
    if (!params.sourceType) {
      throw new Error('sourceType is required');
    }

    const server = db.appMcpServers.create(params);
    emitChanged(internalEventBus);
    log.info(`mcp.registry.create: created entry "${server.name}" (${server.id})`);
    return { server } satisfies { server: AppMcpServer };
  });

  // mcp.registry.update — updates entry, emits event, returns updated entry
  messageHub.onRequest('mcp.registry.update', async (data) => {
    const params = data as UpdateAppMcpServerRequest;

    if (!params.id) {
      throw new Error('id is required');
    }

    const { id, ...updates } = params;
    const server = db.appMcpServers.update(id, updates);
    if (!server) {
      throw new Error(`MCP server not found: ${id}`);
    }

    // Only emit if there were actual fields to update — the repo short-circuits
    // and skips the write when updates is empty, so avoid a spurious event.
    if (Object.keys(updates).length > 0) {
      emitChanged(internalEventBus);
    }
    log.info(`mcp.registry.update: updated entry "${server.name}" (${id})`);
    return { server } satisfies { server: AppMcpServer };
  });

  // mcp.registry.delete — removes entry, emits event
  messageHub.onRequest('mcp.registry.delete', async (data) => {
    const { id } = data as { id: string };

    if (!id) {
      throw new Error('id is required');
    }

    const deleted = db.appMcpServers.delete(id);
    if (!deleted) {
      throw new Error(`MCP server not found: ${id}`);
    }

    emitChanged(internalEventBus);
    log.info(`mcp.registry.delete: deleted entry ${id}`);
    return { success: true } satisfies { success: boolean };
  });

  // mcp.registry.setEnabled — convenience toggle for the enabled field
  messageHub.onRequest('mcp.registry.setEnabled', async (data) => {
    const { id, enabled } = data as { id: string; enabled: boolean };

    if (!id) {
      throw new Error('id is required');
    }
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }

    const server = db.appMcpServers.update(id, { enabled });
    if (!server) {
      throw new Error(`MCP server not found: ${id}`);
    }

    emitChanged(internalEventBus);
    log.info(`mcp.registry.setEnabled: set entry ${id} enabled=${enabled}`);
    return { server } satisfies { server: AppMcpServer };
  });
}

// ---------------------------------------------------------------------------
// Scope-aware enablement handler registration
// ---------------------------------------------------------------------------

export function setupAppMcpHandlers(
  messageHub: MessageHub,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  db: Database
): void {
  // -------------------------------------------------------------------------
  // Scope-aware enablement handlers (M3+)
  //
  // These operate on the unified `mcp_enablement` table. `scopeType='room'`
  // rows are preserved for old DB compatibility, but no active UI/API path
  // writes them.
  // -------------------------------------------------------------------------

  /** `mcp.enablement.list` — every override at a given scope. */
  messageHub.onRequest('mcp.enablement.list', (data) => {
    const { scopeType, scopeId } = data as McpEnablementListRequest;
    if (!scopeType) throw new Error('scopeType is required');
    if (!scopeId) throw new Error('scopeId is required');
    const overrides = db.mcpEnablement.listForScope(scopeType, scopeId);
    return { overrides } satisfies McpEnablementListResponse;
  });

  /** `mcp.enablement.setOverride` — upsert a single override. */
  messageHub.onRequest('mcp.enablement.setOverride', (data) => {
    const { scopeType, scopeId, serverId, enabled } = data as McpEnablementSetOverrideRequest;
    if (!scopeType) throw new Error('scopeType is required');
    if (!scopeId) throw new Error('scopeId is required');
    if (!serverId) throw new Error('serverId is required');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');

    // Validate that the server exists — otherwise the FK CASCADE is the only
    // guard and callers get a useless SQL error.
    const server = db.appMcpServers.get(serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }

    const override = db.mcpEnablement.setOverride(scopeType, scopeId, serverId, enabled);

    internalEventBus
      .publish('mcp.registry.changed', { sessionId: 'global' })
      .catch((err) => log.warn('Failed to emit mcp.registry.changed:', err));

    return { override } satisfies McpEnablementSetOverrideResponse;
  });

  /** `mcp.enablement.clearOverride` — delete one override row. */
  messageHub.onRequest('mcp.enablement.clearOverride', (data) => {
    const { scopeType, scopeId, serverId } = data as McpEnablementClearOverrideRequest;
    if (!scopeType) throw new Error('scopeType is required');
    if (!scopeId) throw new Error('scopeId is required');
    if (!serverId) throw new Error('serverId is required');

    const deleted = db.mcpEnablement.clearOverride(scopeType, scopeId, serverId);
    if (deleted) {
      internalEventBus
        .publish('mcp.registry.changed', { sessionId: 'global' })
        .catch((err) => log.warn('Failed to emit mcp.registry.changed:', err));
    }
    return { deleted } satisfies McpEnablementClearOverrideResponse;
  });

  /** `mcp.enablement.clearScope` — delete every override at a given scope. */
  messageHub.onRequest('mcp.enablement.clearScope', (data) => {
    const { scopeType, scopeId } = data as McpEnablementClearScopeRequest;
    if (!scopeType) throw new Error('scopeType is required');
    if (!scopeId) throw new Error('scopeId is required');

    const deleted = db.mcpEnablement.clearScope(scopeType, scopeId);
    if (deleted > 0) {
      internalEventBus
        .publish('mcp.registry.changed', { sessionId: 'global' })
        .catch((err) => log.warn('Failed to emit mcp.registry.changed:', err));
    }
    return { deleted } satisfies McpEnablementClearScopeResponse;
  });

  // -------------------------------------------------------------------------
  // Session-scope convenience RPC (MCP M6)
  //
  // The Tools modal needs to render every registry entry with its effective
  // enablement for the currently-open session, annotated with the scope that
  // owns that decision. Doing the resolution here means the UI never has to
  // re-implement session > room > space > registry precedence.
  // -------------------------------------------------------------------------

  messageHub.onRequest('session.mcp.list', (data) => {
    const { sessionId } = data as SessionMcpListRequest;
    if (!sessionId) throw new Error('sessionId is required');

    const session = db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const registry = db.appMcpServers.list();
    const chain = scopeChainForSession(session);
    // Only overrides along this session's chain can influence the decision,
    // so filter in SQL instead of walking every row.
    const overrides = db.mcpEnablement.listForScopes(chain);

    // Bucket overrides by scope for O(1) precedence lookup.
    const sessionOverrides = new Map<string, McpEnablementOverride>();
    const roomOverrides = new Map<string, McpEnablementOverride>();
    const spaceOverrides = new Map<string, McpEnablementOverride>();
    for (const ov of overrides) {
      if (ov.scopeType === 'session' && ov.scopeId === sessionId) {
        sessionOverrides.set(ov.serverId, ov);
      } else if (
        ov.scopeType === 'room' &&
        session.context?.roomId &&
        ov.scopeId === session.context.roomId
      ) {
        roomOverrides.set(ov.serverId, ov);
      } else if (
        ov.scopeType === 'space' &&
        session.context?.spaceId &&
        ov.scopeId === session.context.spaceId
      ) {
        spaceOverrides.set(ov.serverId, ov);
      }
    }

    const entries: SessionMcpServerEntry[] = registry.map((server) => {
      const sessionOv = sessionOverrides.get(server.id);
      if (sessionOv) {
        return {
          server,
          enabled: sessionOv.enabled,
          source: 'session' as McpEffectiveEnablementSource,
          override: sessionOv,
        };
      }
      const roomOv = roomOverrides.get(server.id);
      if (roomOv) {
        return {
          server,
          enabled: roomOv.enabled,
          source: 'room' as McpEffectiveEnablementSource,
          override: roomOv,
        };
      }
      const spaceOv = spaceOverrides.get(server.id);
      if (spaceOv) {
        return {
          server,
          enabled: spaceOv.enabled,
          source: 'space' as McpEffectiveEnablementSource,
          override: spaceOv,
        };
      }
      return {
        server,
        enabled: server.enabled,
        source: 'registry' as McpEffectiveEnablementSource,
      };
    });

    return { entries } satisfies SessionMcpListResponse;
  });
}
