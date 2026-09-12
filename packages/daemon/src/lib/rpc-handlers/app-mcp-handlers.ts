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
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository.ts';
import type { Database } from '../../storage/database.ts';
import type {
  McpEnablementClearOverrideRequest,
  McpEnablementClearOverrideResponse,
  McpEnablementSetOverrideRequest,
  McpEnablementSetOverrideResponse,
} from '@hyperneo/shared';
import { scopeChainForSession } from '../mcp/resolve-mcp-servers.ts';
import { Logger } from '../logger.ts';

const log = new Logger('app-mcp-handlers');

export interface AppMcpHandlerContext {
  db: { appMcpServers: AppMcpServerRepository };
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
}

function emitChanged(internalEventBus: InternalEventBus<DaemonInternalEventMap>): void {
  internalEventBus.publish('mcp.registry.changed', { sessionId: 'global' }).catch((err) => {
    log.warn('Failed to emit mcp.registry.changed:', err);
  });
}

export function registerAppMcpHandlers(messageHub: MessageHub, ctx: AppMcpHandlerContext): void {
  const { db, internalEventBus } = ctx;

  messageHub.onRequest('mcp.registry.list', async () => {
    const servers = db.appMcpServers.list();
    return { servers } satisfies { servers: AppMcpServer[] };
  });

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

    if (Object.keys(updates).length > 0) {
      emitChanged(internalEventBus);
    }
    log.info(`mcp.registry.update: updated entry "${server.name}" (${id})`);
    return { server } satisfies { server: AppMcpServer };
  });

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

export function setupAppMcpHandlers(
  messageHub: MessageHub,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  db: Database
): void {
  messageHub.onRequest('mcp.enablement.setOverride', (data) => {
    const { scopeType, scopeId, serverId, enabled } = data as McpEnablementSetOverrideRequest;
    if (!scopeType) throw new Error('scopeType is required');
    if (!scopeId) throw new Error('scopeId is required');
    if (!serverId) throw new Error('serverId is required');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');

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

  messageHub.onRequest('session.mcp.list', (data) => {
    const { sessionId } = data as SessionMcpListRequest;
    if (!sessionId) throw new Error('sessionId is required');

    const session = db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const registry = db.appMcpServers.list();
    const chain = scopeChainForSession(session);
    const overrides = db.mcpEnablement.listForScopes(chain);

    const sessionOverrides = new Map<string, McpEnablementOverride>();
    const spaceOverrides = new Map<string, McpEnablementOverride>();
    for (const ov of overrides) {
      if (ov.scopeType === 'session' && ov.scopeId === sessionId) {
        sessionOverrides.set(ov.serverId, ov);
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
