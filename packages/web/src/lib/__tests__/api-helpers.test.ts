// @ts-nocheck

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../connection-manager.js', () => {
  const mockHub = {
    request: vi.fn().mockResolvedValue({ acknowledged: true }),
    onEvent: vi.fn(() => () => {}),
    joinRoom: vi.fn(),
    leaveRoom: vi.fn(),
    subscribe: vi.fn(),
    subscribeOptimistic: vi.fn(),
    forceResubscribe: vi.fn(),
    isConnected: vi.fn(() => true),
  };
  return {
    connectionManager: {
      getHubIfConnected: vi.fn(() => mockHub),
      getHub: vi.fn(async () => mockHub),
    },
  };
});

import { ConnectionNotReadyError } from '../errors.js';

import * as apiHelpers from '../api-helpers.js';

import { connectionManager } from '../connection-manager.js';

describe('api-helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (
      connectionManager as unknown as {
        getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
        getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
      }
    ).getHubIfConnected.mockReturnValue({
      request: vi.fn().mockResolvedValue({ acknowledged: true }),
      onEvent: vi.fn(() => () => {}),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      subscribe: vi.fn(),
      subscribeOptimistic: vi.fn(),
      forceResubscribe: vi.fn(),
      isConnected: vi.fn(() => true),
    });
    (
      connectionManager as unknown as {
        getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
        getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
      }
    ).getHub.mockResolvedValue({
      request: vi.fn().mockResolvedValue({ acknowledged: true }),
      onEvent: vi.fn(() => () => {}),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      subscribe: vi.fn(),
      subscribeOptimistic: vi.fn(),
      forceResubscribe: vi.fn(),
      isConnected: vi.fn(() => true),
    });
  });

  describe('ConnectionNotReadyError', () => {
    it('should be throwable with default message', () => {
      const error = new ConnectionNotReadyError();
      expect(error.message).toBe('Connection not ready');
      expect(error.name).toBe('ConnectionNotReadyError');
    });

    it('should be throwable with custom message', () => {
      const error = new ConnectionNotReadyError('Not connected to server');
      expect(error.message).toBe('Not connected to server');
    });

    it('should be instanceof Error', () => {
      const error = new ConnectionNotReadyError();
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('session operations', () => {
    describe('createSession', () => {
      it('should create a session with 15000ms timeout', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ sessionId: 'sess-123', title: 'Test Session' }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.createSession({ workspacePath: '/test/path' });

        expect(result).toEqual({ sessionId: 'sess-123', title: 'Test Session' });
        expect(mockHub.request).toHaveBeenCalledWith(
          'session.create',
          { workspacePath: '/test/path' },
          { timeout: 15000 }
        );
      });

      it('should pass through request data', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ sessionId: 'sess-456' }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const req = {
          workspacePath: '/workspace',
          modelId: 'claude-sonnet-4',
        };

        await apiHelpers.createSession(req);

        expect(mockHub.request).toHaveBeenCalledWith('session.create', req, { timeout: 15000 });
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.createSession({ workspacePath: '/test' })).rejects.toThrow(
          'Not connected to server'
        );
      });

      it('should propagate errors from hub', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockRejectedValue(new Error('Network error')),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        await expect(apiHelpers.createSession({ workspacePath: '/test' })).rejects.toThrow(
          'Network error'
        );
      });
    });

    describe('listSessions', () => {
      it('should list all sessions', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              sessions: [
                { id: 'sess-1', title: 'Session 1' },
                { id: 'sess-2', title: 'Session 2' },
              ],
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.listSessions();

        expect(result).toEqual({
          sessions: [
            { id: 'sess-1', title: 'Session 1' },
            { id: 'sess-2', title: 'Session 2' },
          ],
        });
        expect(mockHub.request).toHaveBeenCalledWith('session.list');
      });

      it('should handle empty sessions list', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ sessions: [] }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.listSessions();

        expect(result).toEqual({ sessions: [] });
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.listSessions()).rejects.toThrow('Not connected to server');
      });
    });

    describe('updateSession', () => {
      it('should update session metadata', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ ok: true }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        await apiHelpers.updateSession('sess-123', { title: 'New Title' });

        expect(mockHub.request).toHaveBeenCalledWith('session.update', {
          sessionId: 'sess-123',
          title: 'New Title',
        });
      });

      it('should update session status', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ ok: true }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        await apiHelpers.updateSession('sess-123', { status: 'archived' });

        expect(mockHub.request).toHaveBeenCalledWith('session.update', {
          sessionId: 'sess-123',
          status: 'archived',
        });
      });

      it('should update multiple fields', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ ok: true }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        await apiHelpers.updateSession('sess-123', {
          title: 'Updated Title',
          status: 'active',
        });

        expect(mockHub.request).toHaveBeenCalledWith('session.update', {
          sessionId: 'sess-123',
          title: 'Updated Title',
          status: 'active',
        });
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.updateSession('sess-123', { title: 'New' })).rejects.toThrow(
          'Not connected to server'
        );
      });
    });

    describe('deleteSession', () => {
      it('should delete a session', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ ok: true }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        await apiHelpers.deleteSession('sess-123');

        expect(mockHub.request).toHaveBeenCalledWith('session.delete', {
          sessionId: 'sess-123',
        });
      });

      it('should propagate delete errors', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockRejectedValue(new Error('Session not found')),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        await expect(apiHelpers.deleteSession('sess-123')).rejects.toThrow('Session not found');
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.deleteSession('sess-123')).rejects.toThrow(
          'Not connected to server'
        );
      });
    });

    describe('resetSessionQuery', () => {
      it('should reset session query with restartQuery flag', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ success: true }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.resetSessionQuery('sess-123');

        expect(result).toEqual({ success: true });
        expect(mockHub.request).toHaveBeenCalledWith('session.resetQuery', {
          sessionId: 'sess-123',
          restartQuery: true,
        });
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.resetSessionQuery('sess-123')).rejects.toThrow(
          'Not connected to server'
        );
      });
    });

    describe('switchCoordinatorMode', () => {
      it('should call session.coordinator.switch with correct params', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ success: true, coordinatorMode: true }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.switchCoordinatorMode('sess-123', true);

        expect(result).toEqual({ success: true, coordinatorMode: true });
        expect(mockHub.request).toHaveBeenCalledWith('session.coordinator.switch', {
          sessionId: 'sess-123',
          coordinatorMode: true,
        });
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.switchCoordinatorMode('sess-123', true)).rejects.toThrow(
          'Not connected to server'
        );
      });
    });

    describe('archiveSession', () => {
      it('should archive session with confirmation', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ success: true, deleted: true }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.archiveSession('sess-123', true);

        expect(result).toEqual({ success: true, deleted: true });
        expect(mockHub.request).toHaveBeenCalledWith('session.archive', {
          sessionId: 'sess-123',
          confirmed: true,
        });
      });

      it('should archive session without confirmation (default)', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ success: true, deleted: false }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.archiveSession('sess-123');

        expect(result).toEqual({ success: true, deleted: false });
        expect(mockHub.request).toHaveBeenCalledWith('session.archive', {
          sessionId: 'sess-123',
          confirmed: false,
        });
      });

      it('should handle unconfirmed archive response', async () => {
        const mockHub = {
          request: vi.fn().mockResolvedValue({ acknowledged: true }).mockResolvedValue({
            success: true,
            deleted: false,
            confirmationRequired: true,
          }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.archiveSession('sess-456', false);

        expect(result.deleted).toBe(false);
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.archiveSession('sess-123')).rejects.toThrow(
          'Not connected to server'
        );
      });
    });
  });

  describe('authentication', () => {
    describe('getAuthStatus', () => {
      it('should get auth status', async () => {
        const mockHub = {
          request: vi.fn().mockResolvedValue({ acknowledged: true }).mockResolvedValue({
            method: 'anthropic-api-key',
            authenticated: true,
            username: 'user@example.com',
          }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.getAuthStatus();

        expect(result).toEqual({
          method: 'anthropic-api-key',
          authenticated: true,
          username: 'user@example.com',
        });
        expect(mockHub.request).toHaveBeenCalledWith('auth.status');
      });

      it('should handle unauthenticated status', async () => {
        const mockHub = {
          request: vi.fn().mockResolvedValue({ acknowledged: true }).mockResolvedValue({
            method: null,
            authenticated: false,
          }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.getAuthStatus();

        expect(result.authenticated).toBe(false);
      });

      it('should handle OAuth auth status', async () => {
        const mockHub = {
          request: vi.fn().mockResolvedValue({ acknowledged: true }).mockResolvedValue({
            method: 'oauth',
            authenticated: true,
            username: 'oauth-user',
          }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.getAuthStatus();

        expect(result.method).toBe('oauth');
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.getAuthStatus()).rejects.toThrow('Not connected to server');
      });
    });
  });

  describe('settings operations', () => {
    describe('updateGlobalSettings', () => {
      it('should update global settings using getHub (async)', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              success: true,
              settings: { permissionMode: 'bypassPermissions' },
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHub.mockResolvedValue(mockHub);

        const result = await apiHelpers.updateGlobalSettings({
          permissionMode: 'bypassPermissions',
        });

        expect(result).toEqual({
          success: true,
          settings: { permissionMode: 'bypassPermissions' },
        });
        expect(mockHub.request).toHaveBeenCalledWith(
          'settings.global.update',
          {
            updates: { permissionMode: 'bypassPermissions' },
          },
          undefined
        );
      });

      it('should update multiple settings', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              success: true,
              settings: {
                permissionMode: 'acceptEdits',
                outputLimiter: { enabled: true },
              },
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHub.mockResolvedValue(mockHub);

        const updates = {
          permissionMode: 'acceptEdits' as const,
          outputLimiter: { enabled: true },
        };

        const result = await apiHelpers.updateGlobalSettings(updates);

        expect(result.success).toBe(true);
      });
    });
  });

  describe('rewind operations', () => {
    describe('getRewindPoints', () => {
      it('should get rewind points for session', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              rewindPoints: [
                {
                  uuid: 'msg-1',
                  content: 'User message 1',
                  timestamp: 1704067200000,
                  turnNumber: 1,
                },
                {
                  uuid: 'msg-2',
                  content: 'User message 2',
                  timestamp: 1704070800000,
                  turnNumber: 2,
                },
              ],
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.getRewindPoints('sess-123');

        expect(result).toEqual({
          rewindPoints: [
            {
              uuid: 'msg-1',
              content: 'User message 1',
              timestamp: 1704067200000,
              turnNumber: 1,
            },
            {
              uuid: 'msg-2',
              content: 'User message 2',
              timestamp: 1704070800000,
              turnNumber: 2,
            },
          ],
        });
        expect(mockHub.request).toHaveBeenCalledWith('rewind.checkpoints', {
          sessionId: 'sess-123',
        });
      });

      it('should handle empty rewind points list', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({ rewindPoints: [] }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.getRewindPoints('sess-123');

        expect(result.rewindPoints).toEqual([]);
      });

      it('should handle error response', async () => {
        const mockHub = {
          request: vi.fn().mockResolvedValue({ acknowledged: true }).mockResolvedValue({
            rewindPoints: [],
            error: 'Failed to fetch rewind points',
          }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.getRewindPoints('sess-123');

        expect(result.error).toBeDefined();
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.getRewindPoints('sess-123')).rejects.toThrow(
          'Not connected to server'
        );
      });
    });

    describe('previewRewind', () => {
      it('should preview rewind to checkpoint', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              preview: {
                filesChanged: ['file1.ts', 'file2.ts'],
                filesDeleted: ['old-file.ts'],
                messagesAffected: [1, 2, 3],
                messageCount: 5,
                targetTurnIndex: 5,
              },
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.previewRewind('sess-123', 'cp-1');

        expect(result).toEqual({
          preview: {
            filesChanged: ['file1.ts', 'file2.ts'],
            filesDeleted: ['old-file.ts'],
            messagesAffected: [1, 2, 3],
            messageCount: 5,
            targetTurnIndex: 5,
          },
        });
        expect(mockHub.request).toHaveBeenCalledWith('rewind.preview', {
          sessionId: 'sess-123',
          checkpointId: 'cp-1',
        });
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.previewRewind('sess-123', 'cp-1')).rejects.toThrow(
          'Not connected to server'
        );
      });
    });

    describe('executeRewind', () => {
      it('should execute rewind with default mode (files)', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              result: {
                success: true,
                filesRestored: ['file1.ts', 'file2.ts'],
                filesDeleted: ['file3.ts'],
                messagesDeleted: [6, 7, 8],
                restoredTurnIndex: 5,
              },
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.executeRewind('sess-123', 'cp-1');

        expect(result).toEqual({
          result: {
            success: true,
            filesRestored: ['file1.ts', 'file2.ts'],
            filesDeleted: ['file3.ts'],
            messagesDeleted: [6, 7, 8],
            restoredTurnIndex: 5,
          },
        });
        expect(mockHub.request).toHaveBeenCalledWith('rewind.execute', {
          sessionId: 'sess-123',
          checkpointId: 'cp-1',
          mode: 'files',
        });
      });

      it('should execute rewind with explicit mode', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              result: {
                success: true,
                messagesDeleted: [5, 6],
                restoredTurnIndex: 3,
              },
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.executeRewind('sess-123', 'cp-1', 'messages');

        expect(result).toEqual({
          result: {
            success: true,
            messagesDeleted: [5, 6],
            restoredTurnIndex: 3,
          },
        });
        expect(mockHub.request).toHaveBeenCalledWith('rewind.execute', {
          sessionId: 'sess-123',
          checkpointId: 'cp-1',
          mode: 'messages',
        });
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.executeRewind('sess-123', 'cp-1')).rejects.toThrow(
          'Not connected to server'
        );
      });
    });

    describe('executeSelectiveRewind', () => {
      it('should execute selective rewind with message IDs', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              result: {
                success: true,
                messagesDeleted: 5,
                filesReverted: ['file1.ts', 'file2.ts'],
              },
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.executeSelectiveRewind('sess-123', [
          'msg-uuid-1',
          'msg-uuid-2',
        ]);

        expect(result).toEqual({
          result: {
            success: true,
            messagesDeleted: 5,
            filesReverted: ['file1.ts', 'file2.ts'],
          },
        });
        expect(mockHub.request).toHaveBeenCalledWith('rewind.executeSelective', {
          sessionId: 'sess-123',
          messageIds: ['msg-uuid-1', 'msg-uuid-2'],
          mode: 'both',
        });
      });

      it('should handle selective rewind failure', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              result: {
                success: false,
                error: 'Failed to rewind',
                messagesDeleted: 0,
                filesReverted: [],
              },
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.executeSelectiveRewind('sess-123', ['msg-1']);

        expect(result.result.success).toBe(false);
        expect(result.result.error).toBe('Failed to rewind');
      });

      it('should throw ConnectionNotReadyError when not connected', async () => {
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(null);

        await expect(apiHelpers.executeSelectiveRewind('sess-123', ['msg-1'])).rejects.toThrow(
          'Not connected to server'
        );
      });

      it('should handle single message ID', async () => {
        const mockHub = {
          request: vi
            .fn()
            .mockResolvedValue({ acknowledged: true })
            .mockResolvedValue({
              result: {
                success: true,
                messagesDeleted: 2,
                filesReverted: ['file1.ts'],
              },
            }),
        };
        (
          connectionManager as unknown as {
            getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
            getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
          }
        ).getHubIfConnected.mockReturnValue(mockHub);

        const result = await apiHelpers.executeSelectiveRewind('sess-123', ['msg-1']);

        expect(result.result.success).toBe(true);
        expect(mockHub.request).toHaveBeenCalledWith('rewind.executeSelective', {
          sessionId: 'sess-123',
          messageIds: ['msg-1'],
          mode: 'both',
        });
      });
    });
  });

  describe('Non-blocking pattern', () => {
    it('should throw immediately when not connected (< 10ms)', async () => {
      (
        connectionManager as unknown as {
          getHubIfConnected: { mockReturnValue: (arg: unknown) => void };
          getHub: { mockResolvedValue: (arg: unknown) => Promise<void> };
        }
      ).getHubIfConnected.mockReturnValue(null);

      const start = Date.now();

      try {
        await apiHelpers.createSession({ workspacePath: '/test' });
      } catch {
        // Expected
      }

      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10);
    });
  });
});
