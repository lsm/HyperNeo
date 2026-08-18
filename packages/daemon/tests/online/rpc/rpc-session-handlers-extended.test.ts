import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('Session RPC Handlers - Extended', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30_000);

  afterEach(async () => {
    if (!daemon) return;
    await daemon.waitForExit();
  }, 15_000);

  async function createSession(
    workspacePath: string,
    config?: Record<string, unknown>
  ): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      config,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  async function getSession(sessionId: string): Promise<Record<string, unknown>> {
    const { session } = (await daemon.messageHub.request('session.get', {
      sessionId,
    })) as { session: Record<string, unknown> };
    return session;
  }

  async function listSessions(status?: string): Promise<Array<Record<string, unknown>>> {
    const result = (await daemon.messageHub.request('session.list', {
      ...(status ? { status } : {}),
    })) as { sessions: Array<Record<string, unknown>> };
    return result.sessions;
  }

  describe('session.archive', () => {
    test('should archive a session', async () => {
      const sessionId = await createSession('/test/session-archive');

      const result = (await daemon.messageHub.request('session.archive', {
        sessionId,
        confirmed: true,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      const session = await getSession(sessionId);
      expect(session.status).toBe('archived');

      const archivedSessions = await listSessions('archived');
      const ids = archivedSessions.map((s) => s.id);
      expect(ids).toContain(sessionId);
    });

    test('should error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.archive', {
          sessionId: 'non-existent-id',
          confirmed: true,
        })
      ).rejects.toThrow();
    });
  });

  describe('session.update', () => {
    test('should update session title', async () => {
      const sessionId = await createSession('/test/session-update-title');

      await daemon.messageHub.request('session.update', {
        sessionId,
        title: 'New Title',
      });

      const session = await getSession(sessionId);
      expect(session.title).toBe('New Title');
    });

    test('should update session config', async () => {
      const sessionId = await createSession('/test/session-update-config');

      await daemon.messageHub.request('session.update', {
        sessionId,
        config: { autoScroll: false },
      });

      const session = await getSession(sessionId);
      expect((session.config as { autoScroll: boolean }).autoScroll).toBe(false);
    });
  });

  describe('session.list', () => {
    test('should list all sessions', async () => {
      const sessionId1 = await createSession('/test/session-list-1');
      const sessionId2 = await createSession('/test/session-list-2');

      const sessions = await listSessions();
      const sessionIds = sessions.map((s) => s.id);
      expect(sessionIds).toContain(sessionId1);
      expect(sessionIds).toContain(sessionId2);
    });

    test('should return empty array when no sessions exist', async () => {
      const sessions = await listSessions();
      expect(sessions).toBeArray();
    });
  });

  describe('session.model.get', () => {
    test('should get current model info', async () => {
      const sessionId = await createSession('/test/session-model-get');

      const result = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      expect(result.currentModel).toBeDefined();
      expect(typeof result.currentModel).toBe('string');
    });

    test('should error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.model.get', { sessionId: 'non-existent' })
      ).rejects.toThrow();
    });
  });

  describe('session.model.switch', () => {
    test('should switch model using alias', async () => {
      const sessionId = await createSession('/test/session-model-switch');

      const result = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'haiku',
        provider: 'anthropic',
      })) as { success: boolean };

      expect(result.success).toBe(true);

      const modelInfo = (await daemon.messageHub.request('session.model.get', {
        sessionId,
      })) as { currentModel: string };

      expect(modelInfo.currentModel).toContain('haiku');
    });

    test('should error for invalid model', async () => {
      const sessionId = await createSession('/test/session-model-switch-invalid');

      const result = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: 'invalid-model-id',
        provider: 'anthropic',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('session.create with config', () => {
    test('should create session with config', async () => {
      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath: '/test/session-with-config',
        config: { permissionMode: 'acceptEdits' },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      const session = await getSession(sessionId);
      expect((session.config as { permissionMode: string }).permissionMode).toBe('acceptEdits');
    });
  });

  describe('session.delete', () => {
    test('should delete session', async () => {
      const sessionId = await createSession('/test/session-delete');

      const result = (await daemon.messageHub.request('session.delete', {
        sessionId,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      await expect(daemon.messageHub.request('session.get', { sessionId })).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('session.thinking.set', () => {
    test('should set thinking level', async () => {
      const sessionId = await createSession('/test/session-thinking');

      const result = (await daemon.messageHub.request('session.thinking.set', {
        sessionId,
        level: 'think8k',
      })) as { success: boolean; thinkingLevel: string };

      expect(result.success).toBe(true);
      expect(result.thinkingLevel).toBe('think8k');
    });

    test('should set think24k thinking level', async () => {
      const sessionId = await createSession('/test/session-thinking-24k');

      const result = (await daemon.messageHub.request('session.thinking.set', {
        sessionId,
        level: 'think24k',
      })) as { success: boolean; thinkingLevel: string };

      expect(result.success).toBe(true);
      expect(result.thinkingLevel).toBe('think24k');
    });

    test('should default to off for invalid level', async () => {
      const sessionId = await createSession('/test/session-thinking-invalid');

      const result = (await daemon.messageHub.request('session.thinking.set', {
        sessionId,
        level: 'invalid',
      })) as { thinkingLevel: string };

      expect(result.thinkingLevel).toBe('off');
    });

    test('should error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.thinking.set', {
          sessionId: 'non-existent',
          level: 'think8k',
        })
      ).rejects.toThrow();
    });
  });

  describe('worktree.cleanup', () => {
    test('should return success with empty cleanedPaths', async () => {
      const result = (await daemon.messageHub.request('worktree.cleanup', {
        workspacePath: '/test/workspace',
      })) as { success: boolean; cleanedPaths: unknown[]; message: string };

      expect(result.success).toBe(true);
      expect(result.cleanedPaths).toBeArray();
      expect(result.message).toContain('orphaned worktree');
    });

    test('should throw an error without workspacePath', async () => {
      await expect(daemon.messageHub.request('worktree.cleanup', {})).rejects.toThrow(
        'workspacePath is required'
      );
    });
  });

  describe('models.list', () => {
    test('should list available models', async () => {
      const result = (await daemon.messageHub.request('models.list', {})) as {
        models: Array<{ id: string; display_name: string }>;
      };

      expect(result.models).toBeArray();
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.models[0]).toHaveProperty('id');
      expect(result.models[0]).toHaveProperty('display_name');
    });

    test('should support forceRefresh parameter', async () => {
      const result = (await daemon.messageHub.request('models.list', {
        forceRefresh: true,
      })) as { cached: boolean };

      expect(result.cached).toBe(false);
    });

    test('should support useCache parameter', async () => {
      const result = (await daemon.messageHub.request('models.list', {
        useCache: false,
      })) as { cached: boolean };

      expect(result.cached).toBe(false);
    });
  });

  describe('models.clearCache', () => {
    test('should clear model cache', async () => {
      const result = (await daemon.messageHub.request('models.clearCache', {})) as {
        success: boolean;
      };

      expect(result.success).toBe(true);
    });
  });

  describe('agent.getState', () => {
    test('should get agent state', async () => {
      const sessionId = await createSession('/test/agent-state');

      const result = (await daemon.messageHub.request('agent.getState', {
        sessionId,
      })) as { state: unknown };

      expect(result.state).toBeDefined();
    });

    test('should error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('agent.getState', { sessionId: 'non-existent' })
      ).rejects.toThrow();
    });
  });

  describe('session.get', () => {
    test('should get session details', async () => {
      const sessionId = await createSession('/test/session-get');

      const session = await getSession(sessionId);

      expect(session).toBeDefined();
      expect(session.id).toBe(sessionId);
      expect(session.workspacePath).toBe('/test/session-get');
    });

    test('should throw error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('session.get', { sessionId: 'non-existent-id' })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('client.interrupt', () => {
    test('should accept interrupt request', async () => {
      const sessionId = await createSession('/test/client-interrupt');

      const result = (await daemon.messageHub.request('client.interrupt', {
        sessionId,
      })) as { accepted: boolean };

      expect(result.accepted).toBe(true);
    });

    test('should error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('client.interrupt', { sessionId: 'non-existent' })
      ).rejects.toThrow();
    });
  });

  describe('session.create - config options', () => {
    test('should create a new session and verify via RPC', async () => {
      const workspacePath = '/test/create-verify';
      const sessionId = await createSession(workspacePath);

      expect(sessionId).toBeString();
      expect(sessionId.length).toBeGreaterThan(0);

      const session = await getSession(sessionId);
      expect(session).toBeDefined();
      expect(session.workspacePath).toBe(workspacePath);
      expect(session.status).toBe('active');
    });

    test('should create session with custom config', async () => {
      const sessionId = await createSession('/test/custom-config', {
        model: 'default',
        maxTokens: 4096,
        temperature: 0.5,
      });

      const session = await getSession(sessionId);
      expect((session.config as { model: string }).model).toMatch(/default|sonnet/);
      expect((session.config as { maxTokens: number }).maxTokens).toBe(4096);
      expect((session.config as { temperature: number }).temperature).toBe(0.5);
    });
  });

  describe('session.update - autoScroll', () => {
    test('should update session config with autoScroll setting', async () => {
      const sessionId = await createSession('/test/autoscroll');

      let session = await getSession(sessionId);
      expect((session.config as { autoScroll: boolean }).autoScroll).toBe(true);

      await daemon.messageHub.request('session.update', {
        sessionId,
        config: { autoScroll: false },
      });

      session = await getSession(sessionId);
      expect((session.config as { autoScroll: boolean }).autoScroll).toBe(false);
      expect((session.config as { model: string }).model).toBeDefined();
      expect((session.config as { maxTokens: number }).maxTokens).toBeDefined();
    });

    test('should toggle autoScroll setting', async () => {
      const sessionId = await createSession('/test/autoscroll-toggle');

      await daemon.messageHub.request('session.update', {
        sessionId,
        config: { autoScroll: true },
      });
      let session = await getSession(sessionId);
      expect((session.config as { autoScroll: boolean }).autoScroll).toBe(true);

      await daemon.messageHub.request('session.update', {
        sessionId,
        config: { autoScroll: false },
      });
      session = await getSession(sessionId);
      expect((session.config as { autoScroll: boolean }).autoScroll).toBe(false);
    });
  });

  describe('session.delete - cascading', () => {
    test('should delete session and verify via RPC', async () => {
      const sessionId = await createSession('/test/delete-cascade');

      await daemon.messageHub.request('session.delete', { sessionId });
      await expect(daemon.messageHub.request('session.get', { sessionId })).rejects.toThrow(
        'Session not found'
      );
    }, 15000);
  });
});
