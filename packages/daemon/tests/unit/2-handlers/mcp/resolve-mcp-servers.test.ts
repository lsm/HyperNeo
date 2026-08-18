import { describe, expect, test } from 'bun:test';
import {
  resolveMcpServers,
  scopeChainForSession,
} from '../../../../src/lib/mcp/resolve-mcp-servers';
import type { AppMcpServer, McpEnablementOverride } from '@hyperneo/shared';

function server(id: string, enabled: boolean, partial: Partial<AppMcpServer> = {}): AppMcpServer {
  return {
    id,
    name: partial.name ?? id,
    sourceType: partial.sourceType ?? 'stdio',
    command: 'echo',
    enabled,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function override(
  scopeType: 'space' | 'room' | 'session',
  scopeId: string,
  serverId: string,
  enabled: boolean
): McpEnablementOverride {
  return { scopeType, scopeId, serverId, enabled };
}

const SESSION_ID = 'sess-1';
const ROOM_ID = 'room-1';
const SPACE_ID = 'space-1';

const session = {
  id: SESSION_ID,
  context: { spaceId: SPACE_ID, roomId: ROOM_ID },
};

describe('resolveMcpServers', () => {
  describe('registry default (no overrides)', () => {
    test('returns only servers whose registry enabled flag is true', () => {
      const registry = [server('a', true), server('b', false), server('c', true)];
      const result = resolveMcpServers(session, registry, []);
      expect(result.map((r) => r.id)).toEqual(['a', 'c']);
    });

    test('empty registry returns empty array', () => {
      expect(resolveMcpServers(session, [], [])).toEqual([]);
    });

    test('preserves the registry input ordering', () => {
      const registry = [server('z', true), server('a', true), server('m', true)];
      const result = resolveMcpServers(session, registry, []);
      expect(result.map((r) => r.id)).toEqual(['z', 'a', 'm']);
    });
  });

  describe('space override', () => {
    test("can disable a registry-enabled server for the session's space", () => {
      const registry = [server('a', true)];
      const overrides = [override('space', SPACE_ID, 'a', false)];
      expect(resolveMcpServers(session, registry, overrides)).toEqual([]);
    });

    test("can enable a registry-disabled server for the session's space", () => {
      const registry = [server('a', false)];
      const overrides = [override('space', SPACE_ID, 'a', true)];
      expect(resolveMcpServers(session, registry, overrides).map((r) => r.id)).toEqual(['a']);
    });

    test('ignores space overrides for a different space', () => {
      const registry = [server('a', true)];
      const overrides = [override('space', 'other-space', 'a', false)];
      expect(resolveMcpServers(session, registry, overrides).map((r) => r.id)).toEqual(['a']);
    });
  });

  describe('room override precedence (room > space)', () => {
    test('room enable wins over space disable', () => {
      const registry = [server('a', false)];
      const overrides = [
        override('space', SPACE_ID, 'a', false),
        override('room', ROOM_ID, 'a', true),
      ];
      expect(resolveMcpServers(session, registry, overrides).map((r) => r.id)).toEqual(['a']);
    });

    test('room disable wins over space enable', () => {
      const registry = [server('a', false)];
      const overrides = [
        override('space', SPACE_ID, 'a', true),
        override('room', ROOM_ID, 'a', false),
      ];
      expect(resolveMcpServers(session, registry, overrides)).toEqual([]);
    });

    test('ignores room overrides for a different room', () => {
      const registry = [server('a', true)];
      const overrides = [override('room', 'other-room', 'a', false)];
      expect(resolveMcpServers(session, registry, overrides).map((r) => r.id)).toEqual(['a']);
    });
  });

  describe('session override precedence (session > room > space)', () => {
    test('session enable wins over room + space disable', () => {
      const registry = [server('a', false)];
      const overrides = [
        override('space', SPACE_ID, 'a', false),
        override('room', ROOM_ID, 'a', false),
        override('session', SESSION_ID, 'a', true),
      ];
      expect(resolveMcpServers(session, registry, overrides).map((r) => r.id)).toEqual(['a']);
    });

    test('session disable wins over room + space enable', () => {
      const registry = [server('a', true)];
      const overrides = [
        override('space', SPACE_ID, 'a', true),
        override('room', ROOM_ID, 'a', true),
        override('session', SESSION_ID, 'a', false),
      ];
      expect(resolveMcpServers(session, registry, overrides)).toEqual([]);
    });

    test('ignores session overrides for a different session', () => {
      const registry = [server('a', true)];
      const overrides = [override('session', 'other-session', 'a', false)];
      expect(resolveMcpServers(session, registry, overrides).map((r) => r.id)).toEqual(['a']);
    });
  });

  describe('multiple servers, mixed overrides', () => {
    test('applies the correct rule per-server in a single call', () => {
      const registry = [
        server('reg-on', true),
        server('reg-off', false),
        server('space-off', true),
        server('room-on', false),
        server('session-on', false),
        server('session-off', true),
      ];
      const overrides = [
        override('space', SPACE_ID, 'space-off', false),
        override('room', ROOM_ID, 'room-on', true),
        override('session', SESSION_ID, 'session-on', true),
        override('session', SESSION_ID, 'session-off', false),
        override('space', 'other-space', 'reg-on', false),
        override('room', 'other-room', 'reg-on', false),
        override('session', 'other-session', 'reg-on', false),
      ];
      const ids = resolveMcpServers(session, registry, overrides).map((r) => r.id);
      expect(ids).toEqual(['reg-on', 'room-on', 'session-on']);
    });
  });

  describe('context-less sessions', () => {
    test('falls back entirely to registry defaults when no space/room', () => {
      const registry = [server('a', true), server('b', false)];
      const overrides = [
        override('space', SPACE_ID, 'a', false),
        override('room', ROOM_ID, 'b', true),
      ];
      const result = resolveMcpServers({ id: 'global' }, registry, overrides);
      expect(result.map((r) => r.id)).toEqual(['a']);
    });

    test('session override still applies to context-less sessions', () => {
      const registry = [server('a', false)];
      const overrides = [override('session', 'global', 'a', true)];
      const result = resolveMcpServers({ id: 'global' }, registry, overrides);
      expect(result.map((r) => r.id)).toEqual(['a']);
    });
  });

  describe('scopeChainForSession', () => {
    test('returns every scope the session has', () => {
      const chain = scopeChainForSession(session);
      expect(chain).toEqual([
        { scopeType: 'session', scopeId: SESSION_ID },
        { scopeType: 'room', scopeId: ROOM_ID },
        { scopeType: 'space', scopeId: SPACE_ID },
      ]);
    });

    test('omits scopes without an id', () => {
      const chain = scopeChainForSession({ id: 'global' });
      expect(chain).toEqual([{ scopeType: 'session', scopeId: 'global' }]);
    });

    test('keeps session-only and space-only cases distinct', () => {
      const roomOnly = scopeChainForSession({ id: 's', context: { roomId: 'r' } });
      expect(roomOnly).toEqual([
        { scopeType: 'session', scopeId: 's' },
        { scopeType: 'room', scopeId: 'r' },
      ]);
      const spaceOnly = scopeChainForSession({ id: 's', context: { spaceId: 'sp' } });
      expect(spaceOnly).toEqual([
        { scopeType: 'session', scopeId: 's' },
        { scopeType: 'space', scopeId: 'sp' },
      ]);
    });
  });
});
