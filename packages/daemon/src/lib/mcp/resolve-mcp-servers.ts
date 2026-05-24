/**
 * resolveMcpServers — pure function for MCP M3.
 *
 * Decides which app-level MCP registry entries are effectively enabled for a
 * given session, given the full set of registered servers and every explicit
 * per-scope override.
 *
 * Precedence (most specific wins):
 *   session > room > space > registry default
 *
 * A "registry default" is the `enabled` flag on the registry row itself. An
 * "override" is a row in the `mcp_enablement` table targeting the session's
 * space/room/session id. Missing override rows mean "inherit from the next
 * less-specific scope".
 *
 * This function is intentionally I/O-free: callers build the inputs (read the
 * registry, fetch the overrides for the session's scope chain) and pass them in.
 * Keeping resolution a pure function means:
 *   - Every session spawn path (room chat, space agents, ad-hoc coder sessions, …)
 *     funnels through the same decision logic.
 *   - The precedence matrix is trivial to unit-test without a database.
 *   - The resolver never triggers surprise DB reads in hot paths.
 */

import type { AppMcpServer, McpEnablementOverride, Session } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subset of `Session` that the resolver actually needs. Accepting this narrower
 * type (instead of the full `Session`) makes the resolver trivial to use from
 * contexts that only have a `SessionContext` (e.g. when spawning a worker that
 * doesn't yet have a full Session row persisted).
 */
export interface ResolveMcpServersSession {
  /** The session's unique id. */
  id: string;
  /** Optional scoping context; missing values skip that scope level. */
  context?: {
    spaceId?: string;
    roomId?: string;
  };
}

/**
 * Resolve the effective set of MCP servers for a session.
 *
 * @param session  - The session whose enablement we're computing. Only `id`
 *                   and `context.{spaceId, roomId}` are consulted.
 * @param registry - Every registered `AppMcpServer` the caller is prepared to
 *                   serve. Typically `db.appMcpServers.list()`. The resolver
 *                   does not filter on the registry row's `enabled` flag when
 *                   an explicit override is present — an override to enable
 *                   wins even if the registry default is "disabled".
 * @param overrides - Every `mcp_enablement` row matching any scope in the
 *                    session's scope chain. Other rows are ignored. Typically
 *                    `db.mcpEnablement.listForScopes(scopeChain)`.
 *
 * @returns The subset of `registry` that is effectively enabled for the given
 *          session, preserving the registry's original ordering. The returned
 *          array always references the same `AppMcpServer` objects the caller
 *          supplied; the resolver never mutates or clones them.
 */
export function resolveMcpServers(
  session: ResolveMcpServersSession | Session,
  registry: readonly AppMcpServer[],
  overrides: readonly McpEnablementOverride[]
): AppMcpServer[] {
  const ctx = (session as ResolveMcpServersSession).context ?? {};
  const sessionId = session.id;
  const { spaceId, roomId } = ctx;

  // Group overrides by (scopeType, scopeId, serverId) for O(1) lookup. The
  // input may contain overrides for scopes the session doesn't care about
  // (e.g. another room); those are ignored silently.
  const sessionOverrides = new Map<string, McpEnablementOverride>(); // serverId → override
  const roomOverrides = new Map<string, McpEnablementOverride>();
  const spaceOverrides = new Map<string, McpEnablementOverride>();

  for (const ov of overrides) {
    if (ov.scopeType === 'session' && ov.scopeId === sessionId) {
      sessionOverrides.set(ov.serverId, ov);
    } else if (ov.scopeType === 'room' && roomId && ov.scopeId === roomId) {
      roomOverrides.set(ov.serverId, ov);
    } else if (ov.scopeType === 'space' && spaceId && ov.scopeId === spaceId) {
      spaceOverrides.set(ov.serverId, ov);
    }
    // Overrides for other sessions/rooms/spaces: ignored.
  }

  const result: AppMcpServer[] = [];
  for (const entry of registry) {
    if (isEffectivelyEnabled(entry, sessionOverrides, roomOverrides, spaceOverrides)) {
      result.push(entry);
    }
  }
  return result;
}

/**
 * Convenience wrapper: compute the scope chain the resolver needs given a
 * session. The caller should pass the result to
 * `McpEnablementRepository.listForScopes()` to fetch only the relevant rows.
 *
 * The chain orders scopes from most specific to least specific, though the
 * resolver itself ignores order — that's purely a convenience for humans
 * eyeballing the query.
 */
export function scopeChainForSession(
  session: ResolveMcpServersSession | Session
): Array<{ scopeType: 'session' | 'room' | 'space'; scopeId: string }> {
  const ctx = (session as ResolveMcpServersSession).context ?? {};
  const chain: Array<{ scopeType: 'session' | 'room' | 'space'; scopeId: string }> = [];
  chain.push({ scopeType: 'session', scopeId: session.id });
  if (ctx.roomId) chain.push({ scopeType: 'room', scopeId: ctx.roomId });
  if (ctx.spaceId) chain.push({ scopeType: 'space', scopeId: ctx.spaceId });
  return chain;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Apply precedence rules for a single registry entry:
 *   1. If a session override exists, it wins outright.
 *   2. Otherwise if a room override exists, it wins.
 *   3. Otherwise if a space override exists, it wins.
 *   4. Otherwise fall back to the registry row's own `enabled` flag.
 */
function isEffectivelyEnabled(
  entry: AppMcpServer,
  sessionOverrides: Map<string, McpEnablementOverride>,
  roomOverrides: Map<string, McpEnablementOverride>,
  spaceOverrides: Map<string, McpEnablementOverride>
): boolean {
  const sessionOv = sessionOverrides.get(entry.id);
  if (sessionOv) return sessionOv.enabled;

  const roomOv = roomOverrides.get(entry.id);
  if (roomOv) return roomOv.enabled;

  const spaceOv = spaceOverrides.get(entry.id);
  if (spaceOv) return spaceOv.enabled;

  return entry.enabled;
}
