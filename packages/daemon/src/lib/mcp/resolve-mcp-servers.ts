import type { AppMcpServer, McpEnablementOverride, Session } from '@hyperneo/shared';

export interface ResolveMcpServersSession {
  id: string;
  context?: {
    spaceId?: string;
    roomId?: string;
  };
}

export function resolveMcpServers(
  session: ResolveMcpServersSession | Session,
  registry: readonly AppMcpServer[],
  overrides: readonly McpEnablementOverride[]
): AppMcpServer[] {
  const ctx = (session as ResolveMcpServersSession).context ?? {};
  const sessionId = session.id;
  const { spaceId, roomId } = ctx;

  const sessionOverrides = new Map<string, McpEnablementOverride>();
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
  }

  const result: AppMcpServer[] = [];
  for (const entry of registry) {
    if (isEffectivelyEnabled(entry, sessionOverrides, roomOverrides, spaceOverrides)) {
      result.push(entry);
    }
  }
  return result;
}

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
