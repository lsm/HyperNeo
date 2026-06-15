/**
 * SlashCommandManager Tests
 *
 * Tests for slash command fetching and caching.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  SlashCommandManager,
  type SlashCommandManagerContext,
} from '../../../../src/lib/agent/slash-command-manager';
import type { Session } from '@neokai/shared';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { Logger } from '../../../../src/lib/logger';

describe('SlashCommandManager', () => {
  let manager: SlashCommandManager;
  let mockSession: Session;
  let mockDb: Database;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockLogger: Logger;
  let mockQueryObject: Query | null;
  let updateSessionSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let supportedCommandsSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSession = {
      id: 'test-session-id',
      title: 'Test Session',
      workspacePath: '/test/path',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'default',
        maxTokens: 8192,
        temperature: 1.0,
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    };

    updateSessionSpy = mock(() => {});
    mockDb = {
      updateSession: updateSessionSpy,
    } as unknown as Database;

    emitSpy = mock(async () => {});
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;

    mockLogger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    supportedCommandsSpy = mock(async () => [
      { name: '/help', description: 'Get help' },
      { name: '/context', description: 'Show context' },
      { name: '/compact', description: 'Compact conversation' },
    ]);

    mockQueryObject = {
      supportedCommands: supportedCommandsSpy,
    } as unknown as Query;
  });

  function createContext(
    sessionOverrides: Partial<Session> = {},
    queryObject: Query | null = mockQueryObject
  ): SlashCommandManagerContext {
    const session = { ...mockSession, ...sessionOverrides };
    return {
      session,
      db: mockDb,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      logger: mockLogger,
      queryObject,
    };
  }

  function createManager(
    sessionOverrides: Partial<Session> = {},
    queryObject: Query | null = mockQueryObject
  ): SlashCommandManager {
    return new SlashCommandManager(createContext(sessionOverrides, queryObject));
  }

  describe('constructor', () => {
    it('should restore commands from session if available', () => {
      const existingCommands = ['/help', '/clear', '/context'];
      manager = createManager({ availableCommands: existingCommands });

      // Commands should be restored from session
      expect(manager).toBeDefined();
    });

    it('should not restore if session has no commands', () => {
      manager = createManager({ availableCommands: [] });

      // Log should not be called for restoration
      expect(mockLogger.log).not.toHaveBeenCalled();
    });

    it('should not restore if availableCommands is undefined', () => {
      manager = createManager({ availableCommands: undefined });

      expect(mockLogger.log).not.toHaveBeenCalled();
    });
  });

  describe('getSlashCommands', () => {
    it('should return cached commands if available', async () => {
      const existingCommands = ['/help', '/clear'];
      manager = createManager({ availableCommands: existingCommands });

      const commands = await manager.getSlashCommands();

      expect(commands).toEqual(existingCommands);
    });

    it('should fetch from SDK if no cached commands', async () => {
      manager = createManager();

      const commands = await manager.getSlashCommands();

      expect(supportedCommandsSpy).toHaveBeenCalled();
      expect(commands.length).toBeGreaterThan(0);
      expect(commands).toContain('help');
      expect(commands).toContain('context');
    });

    it('should fallback to built-in commands if SDK returns nothing', async () => {
      supportedCommandsSpy.mockResolvedValue([]);
      manager = createManager({}, null); // No query object

      const commands = await manager.getSlashCommands();

      // Should have built-in commands
      expect(commands.length).toBeGreaterThan(0);
    });

    it('should treat restored cached commands as authoritative', async () => {
      const existingCommands = ['/cached-command'];
      manager = createManager({ availableCommands: existingCommands });

      const commands = await manager.getSlashCommands();
      expect(commands).toEqual(existingCommands);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(supportedCommandsSpy).not.toHaveBeenCalled();
    });
  });

  describe('fetchAndCache', () => {
    it('should fetch commands from SDK and cache them', async () => {
      manager = createManager();

      await manager.fetchAndCache();

      // Should update session in database
      expect(updateSessionSpy).toHaveBeenCalledWith('test-session-id', {
        availableCommands: expect.arrayContaining(['help', 'context']),
      });

      // Should emit event
      expect(emitSpy).toHaveBeenCalledWith('commands.updated', {
        sessionId: 'test-session-id',
        commands: expect.arrayContaining(['help']),
      });
    });

    it('should return early if no query object', async () => {
      manager = createManager({}, null);

      await manager.fetchAndCache();

      expect(supportedCommandsSpy).not.toHaveBeenCalled();
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('should return early if supportedCommands is not a function', async () => {
      const invalidQueryObject = {} as Query;
      manager = createManager({}, invalidQueryObject);

      await manager.fetchAndCache();

      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('should only fetch once (commandsFetchedFromSDK flag)', async () => {
      manager = createManager();

      await manager.fetchAndCache();
      await manager.fetchAndCache();
      await manager.fetchAndCache();

      // Should only call SDK once
      expect(supportedCommandsSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle SDK errors gracefully', async () => {
      supportedCommandsSpy.mockRejectedValue(new Error('SDK error'));
      manager = createManager();

      // Should not throw
      await manager.fetchAndCache();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to fetch slash commands:',
        expect.any(Error)
      );
    });

    it('should combine SDK commands with built-in commands', async () => {
      supportedCommandsSpy.mockResolvedValue([{ name: '/custom', description: 'Custom command' }]);
      manager = createManager();

      await manager.fetchAndCache();

      const commands = await manager.getSlashCommands();

      // Should have SDK command
      expect(commands).toContain('custom');
      // Should have SDK built-in commands
      expect(commands).toContain('clear');
      expect(commands).toContain('help');
    });

    it('should flatten aliases from the initial SDK command fetch', async () => {
      supportedCommandsSpy.mockResolvedValue([
        { name: '/status', aliases: ['/cost', 'stats'], description: 'Status command' },
      ]);
      manager = createManager();

      await manager.fetchAndCache();

      const commands = await manager.getSlashCommands();

      expect(commands).toContain('status');
      expect(commands).toContain('cost');
      expect(commands).toContain('stats');
      expect(commands).not.toContain('/status');
      expect(commands).not.toContain('/cost');
    });

    it('should deduplicate commands', async () => {
      supportedCommandsSpy.mockResolvedValue([
        { name: 'help', description: 'Help' },
        { name: 'clear', description: 'Clear' },
      ]);
      manager = createManager();

      await manager.fetchAndCache();

      const commands = await manager.getSlashCommands();

      // Should not have duplicate 'help' or 'clear'
      const helpCount = commands.filter((c) => c === 'help').length;
      const clearCount = commands.filter((c) => c === 'clear').length;
      expect(helpCount).toBe(1);
      expect(clearCount).toBe(1);
    });
  });
});
