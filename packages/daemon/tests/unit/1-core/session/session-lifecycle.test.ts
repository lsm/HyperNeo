import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('@hyperneo/shared/sdk/type-guards', () => ({
  isSDKAssistantMessage: (msg: { type: string }) => msg.type === 'assistant',
  isSDKUserMessage: (msg: { type: string; isReplay?: boolean }) =>
    msg.type === 'user' && (!('isReplay' in msg) || msg.isReplay === false),
  isSDKUserMessageReplay: (msg: { type: string; isReplay?: boolean }) =>
    msg.type === 'user' && 'isReplay' in msg && msg.isReplay === true,
  isSDKResultMessage: (msg: { type: string }) => msg.type === 'result',
  isSDKResultSuccess: (msg: { type: string; subtype?: string }) =>
    msg.type === 'result' && msg.subtype === 'success',
  isSDKResultError: (msg: { type: string; subtype?: string }) =>
    msg.type === 'result' && msg.subtype !== 'success',
  isSDKSystemMessage: (msg: { type: string }) => msg.type === 'system',
  isSDKSystemInit: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'init',
  isSDKCompactBoundary: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'compact_boundary',
  isSDKStatusMessage: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'status',
  isSDKModelRefusalFallbackMessage: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'model_refusal_fallback',
  isSDKSessionStateChangedMessage: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'session_state_changed',
  isSDKCommandsChangedMessage: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'commands_changed',
  isSDKThinkingTokensMessage: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'thinking_tokens',
  flattenSDKSlashCommands: (commands: Array<{ name?: string; aliases?: string[] }>) => {
    const names = new Set<string>();
    const normalize = (n: string) => (n.startsWith('/') ? n.slice(1) : n);
    for (const command of commands) {
      if (typeof command.name === 'string' && command.name.length > 0) {
        names.add(normalize(command.name));
      }
      for (const alias of command.aliases ?? []) {
        if (typeof alias === 'string' && alias.length > 0) {
          names.add(normalize(alias));
        }
      }
    }
    return [...names].filter((name) => name.length > 0);
  },
  isSDKHookResponse: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'hook_response',
  isSDKAPIRetryMessage: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'api_retry',
  isSDKStreamEvent: (msg: { type: string }) => msg.type === 'stream_event',
  isSDKToolProgressMessage: (msg: { type: string }) => msg.type === 'tool_progress',
  isSDKAuthStatusMessage: (msg: { type: string }) => msg.type === 'auth_status',
  isSDKRateLimitEvent: (msg: { type: string }) => msg.type === 'rate_limit_event',
  isToolUseBlock: (block: { type: string }) => block.type === 'tool_use',
  isTextBlock: (block: { type: string }) => block.type === 'text',
  isThinkingBlock: (block: { type: string }) => block.type === 'thinking',
  isUserVisibleMessage: (msg: { type: string }) =>
    msg.type !== 'stream_event' && msg.type !== 'api_retry',
}));

mock.module('../../../../src/lib/provider-service', () => ({
  getProviderService: () => ({
    getDefaultProvider: async () => 'anthropic',
    getProviderApiKey: (_provider: string) => process.env.ANTHROPIC_API_KEY || undefined,
    isProviderAvailable: async () => false,
    mergeProviderEnvVars: (s: object) => s,
    applyEnvVarsToProcessForProvider: (provider: string, modelId: string) => {
      if (provider !== 'glm') return {};
      const originalEnv = {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      };
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = modelId;
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = modelId;
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = modelId;
      return originalEnv;
    },
    getTitleGenerationConfig: async (_provider: string) => ({
      modelId: 'claude-sonnet-4-20250514',
    }),
    getTitleGenerationModels: async (provider: string, sessionModelId: string) => ({
      providerModelId: provider === 'glm' ? 'glm-5-turbo' : sessionModelId,
      sdkModelId: provider === 'glm' ? 'default' : sessionModelId,
    }),
    getEnvVarsForModel: (modelId: string, provider: string) =>
      provider === 'glm'
        ? {
            ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
            ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
            ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
          }
        : {},
    restoreEnvVars: (originalEnv: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  }),
  mergeProviderEnvVars: (session: object) => session,
}));

const mockKimiModels: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4.5',
    alias: 'sonnet',
    family: 'sonnet',
    provider: 'anthropic',
    contextWindow: 200_000,
    description: 'Claude Sonnet',
    releaseDate: '2025-01-01',
    preferContextWindowMetadata: true,
    available: true,
    providerAliases: ['sonnet', 'claude-sonnet-4-20250514'],
  },
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4.5',
    alias: 'opus',
    family: 'opus',
    provider: 'anthropic',
    contextWindow: 200_000,
    description: 'Claude Opus',
    releaseDate: '2025-01-01',
    preferContextWindowMetadata: true,
    available: true,
    providerAliases: ['opus', 'claude-opus-4-20250514'],
  },
  {
    id: 'kimi-k3[1m]',
    name: 'Kimi K3',
    alias: 'k3',
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 1_048_576,
    description: 'Kimi K3 1M context',
    releaseDate: '2026-01-01',
    preferContextWindowMetadata: true,
    available: true,
    providerAliases: ['k3', 'kimi-k3', 'k3[1m]', 'kimi-k3[1m]'],
    providerAliasPrefixes: ['moonshot-k3'],
  },
  {
    id: 'k3-256k',
    name: 'Kimi K3 (256K)',
    alias: 'k3-256k',
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 262_144,
    description: 'Kimi K3 256K context',
    releaseDate: '2026-01-01',
    preferContextWindowMetadata: true,
    available: true,
    providerAliases: ['kimi-k3-256k'],
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi for Coding',
    alias: 'kimi',
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 262_144,
    description: 'Kimi K2.7 coding',
    releaseDate: '2026-01-01',
    preferContextWindowMetadata: true,
    available: true,
    providerAliases: ['kimi', 'kimi-for-coding', 'kimi-k2.7-code'],
  },
];

import type { MessageHub, ModelInfo, Session } from '@hyperneo/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import { clearModelsCache, setModelsCache } from '../../../../src/lib/model-service';
import { getProviderRegistry } from '../../../../src/lib/providers/registry';
import type { AgentSessionFactory, SessionCache } from '../../../../src/lib/session/session-cache';
import {
  generateBranchName,
  SessionLifecycle,
  type SessionLifecycleConfig,
} from '../../../../src/lib/session/session-lifecycle';
import type { ToolsConfigManager } from '../../../../src/lib/session/tools-config';
import type { WorktreeManager } from '../../../../src/lib/worktree-manager';
import type { Database } from '../../../../src/storage/database';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { Database as RawDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('SessionLifecycle', () => {
  let lifecycle: SessionLifecycle;
  let mockDb: Database;
  let mockWorktreeManager: WorktreeManager;
  let mockSessionCache: SessionCache;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageHub: MessageHub;
  let mockToolsConfigManager: ToolsConfigManager;
  let mockAgentSessionFactory: AgentSessionFactory;
  let config: SessionLifecycleConfig;
  let createdSessions: Session[];

  beforeEach(() => {
    setModelsCache(new Map([['global', mockKimiModels]]));

    createdSessions = [];

    mockDb = {
      createSession: mock((session: Session) => {
        createdSessions.push(session);
      }),
      updateSession: mock(() => {}),
      deleteSession: mock(() => {}),
      getSession: mock(() => null),
      getGlobalSettings: mock(() => ({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      })),
    } as unknown as Database;

    mockWorktreeManager = {
      detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
      createWorktree: mock(async () => null),
      removeWorktree: mock(async () => {}),
      verifyWorktree: mock(async () => false),
      renameBranch: mock(async () => true),
      getCurrentBranch: mock(async () => 'main'),
    } as unknown as WorktreeManager;

    const mockAgentSession = {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => ({
        id: 'test-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        metadata: { titleGenerated: false, worktreeChoice: undefined },
        config: {},
        worktree: undefined,
      })),
    };
    mockSessionCache = {
      set: mock(() => {}),
      get: mock(() => mockAgentSession),
      has: mock(() => false),
      remove: mock(() => {}),
      clear: mock(() => {}),
      getAsync: mock(async () => mockAgentSession),
    } as unknown as SessionCache;

    mockInternalEventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    mockMessageHub = {
      event: mock(async () => {}),
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    mockToolsConfigManager = {} as unknown as ToolsConfigManager;

    mockAgentSessionFactory = mock(() => mockAgentSession);

    config = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
      workspaceRoot: '/default/workspace',
      disableWorktrees: true,
    };

    lifecycle = new SessionLifecycle(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );
  });

  afterEach(() => {
    clearModelsCache();
  });

  describe('create', () => {
    it('should create a session with default values', async () => {
      const sessionId = await lifecycle.create({});

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          id: sessionId,
          title: 'New Session',
          status: 'active',
        }),
        expect.anything()
      );
    });

    it('should create a session with provided title', async () => {
      const sessionId = await lifecycle.create({ title: 'My Custom Title' });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My Custom Title',
        }),
        expect.anything()
      );
    });

    it('should set titleGenerated to true when title is provided', async () => {
      await lifecycle.create({ title: 'Custom Title' });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            titleGenerated: true,
          }),
        }),
        expect.anything()
      );
    });

    it('should set titleGenerated to false when no title is provided', async () => {
      await lifecycle.create({});

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            titleGenerated: false,
          }),
        }),
        expect.anything()
      );
    });

    it('should create a session with custom workspace path', async () => {
      const sessionId = await lifecycle.create({
        workspacePath: '/custom/workspace',
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: '/custom/workspace',
        }),
        expect.anything()
      );
    });

    it('should create unbound session when no workspacePath specified', async () => {
      await lifecycle.create({});

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: null,
        }),
        expect.anything()
      );
    });

    it('explicit workspacePath is used as-is and does NOT fall back to config.workspaceRoot', async () => {
      await lifecycle.create({ workspacePath: '/explicit/path' });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: '/explicit/path',
        }),
        expect.anything()
      );
    });

    it('space session creation stores spaceId in session context alongside workspacePath', async () => {
      await lifecycle.create({ spaceId: 'space-1', workspacePath: '/space/workspace' });

      expect(createdSessions).toHaveLength(1);
      expect(createdSessions[0]!.context).toEqual({ spaceId: 'space-1' });
      expect(createdSessions[0]!.workspacePath).toBe('/space/workspace');
    });

    it('session without spaceId or lobbyId carries no space context reference', async () => {
      await lifecycle.create({ workspacePath: '/plain/workspace' });

      expect(createdSessions).toHaveLength(1);
      expect(createdSessions[0]!.context).toBeUndefined();
    });

    it('space_chat session without workspacePath throws', async () => {
      await expect(lifecycle.create({ sessionType: 'space_chat' })).rejects.toThrow(
        "Session type 'space_chat' requires explicit workspacePath"
      );
    });

    it('worker session without workspacePath creates unbound session', async () => {
      await lifecycle.create({ sessionType: 'worker' });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: null,
        }),
        expect.anything()
      );
    });

    it('default (undefined sessionType) session without workspacePath creates unbound session', async () => {
      await lifecycle.create({});

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: null,
        }),
        expect.anything()
      );
    });

    it('should create session with pending_worktree_choice status for git repos', async () => {
      (mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
        isGitRepo: true,
        isBare: false,
        gitRoot: '/test/repo',
      });

      const worktreeEnabledConfig = {
        ...config,
        disableWorktrees: false,
      };
      const worktreeLifecycle = new SessionLifecycle(
        mockDb,
        mockWorktreeManager,
        mockSessionCache,
        mockInternalEventBus,
        mockMessageHub,
        worktreeEnabledConfig,
        mockToolsConfigManager,
        mockAgentSessionFactory
      );

      await worktreeLifecycle.create({ workspacePath: '/test/repo' });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending_worktree_choice',
        }),
        expect.anything()
      );
    });

    it('removes the worktree when session admission is rejected', async () => {
      (mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
        isGitRepo: true,
        isBare: false,
        gitRoot: '/test/repo',
      });
      (mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockResolvedValue({
        isWorktree: true,
        worktreePath: '/test/repo-worktree',
        mainRepoPath: '/test/repo',
        branch: 'session/abc',
      });
      (mockDb.createSession as ReturnType<typeof mock>).mockImplementation(() => {
        throw new Error(
          'Workspace /test/repo is not registered to space space-1; session creation blocked'
        );
      });

      const worktreeLifecycle = new SessionLifecycle(
        mockDb,
        mockWorktreeManager,
        mockSessionCache,
        mockInternalEventBus,
        mockMessageHub,
        { ...config, disableWorktrees: false },
        mockToolsConfigManager,
        mockAgentSessionFactory
      );

      await expect(
        worktreeLifecycle.create({
          workspacePath: '/test/repo',
          spaceId: 'space-1',
          worktreeMode: 'worktree',
        })
      ).rejects.toThrow('is not registered to space');

      expect(mockWorktreeManager.removeWorktree).toHaveBeenCalled();
    });

    describe('space workspace admission against the real registry', () => {
      let rawDb: RawDatabase;
      let repo: SessionRepository;

      beforeEach(() => {
        rawDb = new RawDatabase(':memory:');
        createSpaceTables(rawDb);
        for (const [id, slug, path, name] of [
          ['space-1', 'space-one', '/w/primary', 'Space One'],
          ['space-2', 'space-two', '/other/primary', 'Space Two'],
        ] as const) {
          rawDb
            .prepare(
              `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
               VALUES (?, ?, ?, ?, 0, 0)`
            )
            .run(id, slug, path, name);
        }
        rawDb
          .prepare(
            `INSERT INTO space_workspaces (id, space_id, path, label, is_primary, created_at, updated_at)
             VALUES ('ws-sec', 'space-1', '/w/secondary', 'secondary', 0, 0, 0)`
          )
          .run();

        repo = new SessionRepository(rawDb);

        mockDb = {
          createSession: (
            session: Session,
            options?: { enforceWorkspaceOwnership?: boolean; ownershipPath?: string }
          ) => repo.createSession(session, options),
          isWorkspaceRegisteredToSpace: (spaceId: string, workspacePath: string) =>
            repo.isWorkspaceRegisteredToSpace(spaceId, workspacePath),
          getGlobalSettings: mock(() => ({
            ...DEFAULT_GLOBAL_SETTINGS,
            settingSources: ['user', 'project', 'local'],
          })),
        } as unknown as Database;

        lifecycle = new SessionLifecycle(
          mockDb,
          mockWorktreeManager,
          mockSessionCache,
          mockInternalEventBus,
          mockMessageHub,
          config,
          mockToolsConfigManager,
          mockAgentSessionFactory
        );
      });

      afterEach(() => {
        rawDb.close();
      });

      const countSessions = () =>
        (rawDb.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;

      it('rejects a space session whose workspacePath is not registered to the space', async () => {
        await expect(
          lifecycle.create({ spaceId: 'space-1', workspacePath: '/w/unregistered' })
        ).rejects.toThrow('Workspace /w/unregistered is not registered to space space-1');

        expect(countSessions()).toBe(0);
      });

      it('rejects a space session whose workspacePath is registered to a different space', async () => {
        await expect(
          lifecycle.create({ spaceId: 'space-1', workspacePath: '/other/primary' })
        ).rejects.toThrow('is not registered to space space-1');

        expect(countSessions()).toBe(0);
      });

      it('admits a space session on the primary workspace', async () => {
        const sessionId = await lifecycle.create({
          spaceId: 'space-1',
          workspacePath: '/w/primary',
        });

        const stored = repo.getSession(sessionId);
        expect(stored?.workspacePath).toBe('/w/primary');
        expect(stored?.context).toEqual({ spaceId: 'space-1' });
      });

      it('admits a space session on a registered secondary workspace', async () => {
        const sessionId = await lifecycle.create({
          spaceId: 'space-1',
          workspacePath: '/w/secondary',
        });

        const stored = repo.getSession(sessionId);
        expect(stored?.workspacePath).toBe('/w/secondary');
        expect(stored?.context).toEqual({ spaceId: 'space-1' });
      });

      it('leaves non-space sessions unaffected by the space workspace registry', async () => {
        const sessionId = await lifecycle.create({ workspacePath: '/w/unregistered' });

        const stored = repo.getSession(sessionId);
        expect(stored?.workspacePath).toBe('/w/unregistered');
        expect(stored?.context).toBeUndefined();
      });

      it('still admits a space session without a workspacePath', async () => {
        const sessionId = await lifecycle.create({ spaceId: 'space-1' });

        const stored = repo.getSession(sessionId);
        expect(stored?.workspacePath).toBeNull();
        expect(stored?.context).toEqual({ spaceId: 'space-1' });
      });
    });

    it('should not use worktree choice flow for non-worker sessions', async () => {
      (mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
        isGitRepo: true,
        isBare: false,
        gitRoot: '/test/repo',
      });

      await lifecycle.create({ sessionType: 'space_chat', workspacePath: '/space/workspace' });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'space_chat',
          status: 'active',
          metadata: expect.objectContaining({
            worktreeChoice: undefined,
          }),
        }),
        expect.anything()
      );
    });

    it('should create session with active status for non-git repos', async () => {
      (mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
        isGitRepo: false,
        isBare: false,
      });

      await lifecycle.create({});

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
        }),
        expect.anything()
      );
    });

    it('should create session with active status when worktrees are disabled', async () => {
      (mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
        isGitRepo: true,
        isBare: false,
        gitRoot: '/test/repo',
      });
      config.disableWorktrees = true;

      await lifecycle.create({});

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'active',
        }),
        expect.anything()
      );
    });

    it('should add session to cache after creation', async () => {
      await lifecycle.create({});

      expect(mockSessionCache.set).toHaveBeenCalled();
    });

    it('should emit session.created event', async () => {
      await lifecycle.create({});

      expect(mockInternalEventBus.publish).toHaveBeenCalledWith(
        'session.created',
        expect.objectContaining({
          sessionId: expect.any(String),
          session: expect.any(Object),
        })
      );
    });

    it('should create session with dual-session architecture fields', async () => {
      await lifecycle.create({
        sessionType: 'worker',
        pairedSessionId: 'manager-id',
        parentSessionId: 'parent-id',
        currentTaskId: 'task-123',
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            sessionType: 'worker',
            pairedSessionId: 'manager-id',
            parentSessionId: 'parent-id',
            currentTaskId: 'task-123',
          }),
        }),
        expect.anything()
      );
    });

    it('should create session with custom config', async () => {
      await lifecycle.create({
        config: {
          model: 'claude-opus-4-20250514',
          maxTokens: 4096,
          temperature: 0.5,
          autoScroll: false,
          thinkingLevel: 'think32k',
        },
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'claude-opus-4-20250514',
            maxTokens: 4096,
            temperature: 0.5,
            autoScroll: false,
            thinkingLevel: 'think32k',
          }),
        }),
        expect.anything()
      );
    });

    it('resolves Kimi aliases when no explicit provider is set', async () => {
      await lifecycle.create({
        config: {
          model: 'kimi-k2.7-code',
        },
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'kimi-for-coding',
            provider: 'kimi',
          }),
        }),
        expect.anything()
      );
    });

    it('does not let Kimi aliases override an explicit non-Kimi provider', async () => {
      await lifecycle.create({
        config: {
          provider: 'custom',
          model: 'moonshot-v1-32k',
        },
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'moonshot-v1-32k',
            provider: 'custom',
          }),
        }),
        expect.anything()
      );
    });

    it('preserves the [1m] suffix for Kimi K3 aliases', async () => {
      await lifecycle.create({
        config: {
          model: 'k3[1m]',
        },
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'kimi-k3[1m]',
            provider: 'kimi',
          }),
        }),
        expect.anything()
      );
    });

    it('preserves the [1m] suffix for canonical Kimi K3 ID', async () => {
      await lifecycle.create({
        config: {
          model: 'kimi-k3[1m]',
        },
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'kimi-k3[1m]',
            provider: 'kimi',
          }),
        }),
        expect.anything()
      );
    });

    it('resolves bare k3 alias to the catalog K3 ID with [1m] suffix', async () => {
      await lifecycle.create({
        config: {
          model: 'k3',
        },
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'kimi-k3[1m]',
            provider: 'kimi',
          }),
        }),
        expect.anything()
      );
    });

    it('resolves the kimi-k3-256k alias to the catalog k3-256k ID without a [1m] suffix', async () => {
      await lifecycle.create({
        config: {
          model: 'kimi-k3-256k',
        },
      });

      expect(mockDb.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'k3-256k',
            provider: 'kimi',
          }),
        }),
        expect.anything()
      );
    });

    describe('model curation', () => {
      afterEach(() => {
        getProviderRegistry().setCuratedModels('kimi', undefined);
        getProviderRegistry().setCuratedModels('anthropic', undefined);
      });

      it('rejects a curated-out model requested under an explicit provider', async () => {
        getProviderRegistry().setCuratedModels('kimi', [{ id: 'kimi-for-coding' }]);

        await expect(
          lifecycle.create({ config: { provider: 'kimi', model: 'k3-256k' } })
        ).rejects.toThrow("Model 'k3-256k' is curated out for provider 'kimi'");

        expect(createdSessions).toEqual([]);
      });

      it('creates with a curated-in model under an explicit provider', async () => {
        getProviderRegistry().setCuratedModels('kimi', [{ id: 'kimi-for-coding' }]);

        await lifecycle.create({ config: { provider: 'kimi', model: 'kimi-for-coding' } });

        expect(mockDb.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              model: 'kimi-for-coding',
              provider: 'kimi',
            }),
          }),
          expect.anything()
        );
      });

      it('rejects an unknown model under a curated provider', async () => {
        getProviderRegistry().setCuratedModels('kimi', [{ id: 'kimi-for-coding' }]);

        await expect(
          lifecycle.create({ config: { provider: 'kimi', model: 'totally-custom-model-x' } })
        ).rejects.toThrow("Model 'totally-custom-model-x' is curated out for provider 'kimi'");

        expect(createdSessions).toEqual([]);
      });

      it('creates with an undiscovered model whose ID is a curated entry', async () => {
        getProviderRegistry().setCuratedModels('kimi', [{ id: 'totally-custom-model-x' }]);

        await lifecycle.create({ config: { provider: 'kimi', model: 'totally-custom-model-x' } });

        expect(mockDb.createSession).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              model: 'totally-custom-model-x',
              provider: 'kimi',
            }),
          }),
          expect.anything()
        );
      });

      describe('empty model cache', () => {
        it('rejects a curated-out model requested without a provider', async () => {
          getProviderRegistry().setCuratedModels('anthropic', [{ id: 'sonnet' }]);
          setModelsCache(new Map());

          await expect(lifecycle.create({ config: { model: 'opus' } })).rejects.toThrow(
            "Model 'opus' is curated out for provider 'anthropic'"
          );

          expect(createdSessions).toEqual([]);
        });

        it('creates with a curated-in model requested without a provider', async () => {
          getProviderRegistry().setCuratedModels('anthropic', [{ id: 'sonnet' }]);
          setModelsCache(new Map());

          await lifecycle.create({ config: { model: 'sonnet' } });

          expect(mockDb.createSession).toHaveBeenCalledWith(
            expect.objectContaining({
              config: expect.objectContaining({
                model: 'sonnet',
              }),
            }),
            expect.anything()
          );
        });

        it('rejects an unknown model without a provider under a curated inferred provider', async () => {
          getProviderRegistry().setCuratedModels('anthropic', [{ id: 'sonnet' }]);
          setModelsCache(new Map());

          await expect(
            lifecycle.create({ config: { model: 'totally-custom-model-x' } })
          ).rejects.toThrow(
            "Model 'totally-custom-model-x' is curated out for provider 'anthropic'"
          );

          expect(createdSessions).toEqual([]);
        });
      });
    });

    it('should create session with roomId', async () => {
      await lifecycle.create({
        roomId: 'room-123',
      });

      expect(mockDb.createSession).toHaveBeenCalled();
    });

    it('should create session with createdBy field', async () => {
      await lifecycle.create({
        createdBy: 'human',
      });

      expect(mockDb.createSession).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update session in database', async () => {
      const sessionId = 'test-session-id';
      const updates = { title: 'Updated Title' };

      await lifecycle.update(sessionId, updates);

      expect(mockDb.updateSession).toHaveBeenCalledWith(sessionId, updates);
    });

    it('should update in-memory session if cached', async () => {
      (mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
      const mockAgentSession = {
        updateMetadata: mock(() => {}),
      };
      (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);

      const updates = { title: 'Updated Title' };
      await lifecycle.update('test-id', updates);

      expect(mockAgentSession.updateMetadata).toHaveBeenCalledWith(updates);
    });

    it('should emit session.updated event', async () => {
      await lifecycle.update('test-id', { title: 'New Title' });

      expect(mockInternalEventBus.publish).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId: 'test-id',
          source: 'update',
          session: { title: 'New Title' },
        })
      );
    });
  });

  describe('deleteResources (UI-only: session.delete)', () => {
    it('should delete session from database', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        workspacePath: '/test',
      });

      await lifecycle.deleteResources('test-id', 'ui_session_delete');

      expect(mockDb.deleteSession).toHaveBeenCalledWith('test-id');
    });

    it('should remove session from cache', async () => {
      (mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        workspacePath: '/test',
      });

      await lifecycle.deleteResources('test-id', 'ui_session_delete');

      expect(mockSessionCache.remove).toHaveBeenCalledWith('test-id');
    });

    it('should cleanup agent session if cached', async () => {
      const mockAgentSession = {
        cleanup: mock(async () => {}),
        updateMetadata: mock(() => {}),
      };
      (mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
      (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        workspacePath: '/test',
      });

      await lifecycle.deleteResources('test-id', 'ui_session_delete');

      expect(mockAgentSession.cleanup).toHaveBeenCalled();
    });

    it('should delete worktree if present', async () => {
      const sessionWithWorktree = {
        id: 'test-id',
        workspacePath: '/test',
        worktree: {
          worktreePath: '/test/worktree',
          branch: 'test-branch',
          mainRepoPath: '/test/main',
        },
      };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(sessionWithWorktree);

      await lifecycle.deleteResources('test-id', 'ui_session_delete');

      expect(mockWorktreeManager.removeWorktree).toHaveBeenCalledWith(
        sessionWithWorktree.worktree,
        true
      );
    });

    it('should broadcast deletion event', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        workspacePath: '/test',
      });

      await lifecycle.deleteResources('test-id', 'ui_session_delete');

      expect(mockMessageHub.event).toHaveBeenCalledWith(
        'session.deleted',
        expect.objectContaining({ sessionId: 'test-id' }),
        { channel: 'global' }
      );
      expect(mockInternalEventBus.publish).toHaveBeenCalledWith(
        'session.deleted',
        expect.objectContaining({ sessionId: 'test-id' })
      );
    });

    it('should continue deletion even if agent cleanup fails', async () => {
      const mockAgentSession = {
        cleanup: mock(async () => {
          throw new Error('Cleanup failed');
        }),
        updateMetadata: mock(() => {}),
      };
      (mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
      (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        workspacePath: '/test',
      });

      await lifecycle.deleteResources('test-id', 'ui_session_delete');
      expect(mockDb.deleteSession).toHaveBeenCalledWith('test-id');
    });

    it('should continue deletion even if worktree removal fails', async () => {
      (mockWorktreeManager.removeWorktree as ReturnType<typeof mock>).mockRejectedValue(
        new Error('Worktree removal failed')
      );
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        workspacePath: '/test',
        worktree: {
          worktreePath: '/test/worktree',
          branch: 'test-branch',
          mainRepoPath: '/test/main',
        },
      });

      await lifecycle.deleteResources('test-id', 'ui_session_delete');
      expect(mockDb.deleteSession).toHaveBeenCalledWith('test-id');
    });

    it('commits the archived barrier and cancels durable deliveries BEFORE teardown (#3743968033)', async () => {
      const order: string[] = [];
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        workspacePath: '/test',
        status: 'active',
      });
      (mockDb.updateSession as ReturnType<typeof mock>).mockImplementation(() => {
        order.push('mark-archived');
      });
      const cancelSpy = mock(() => {
        order.push('delivery-cancel');
        return ['msg-uuid-1'];
      });
      const markFailedSpy = mock(() => null);
      mockDb.getJobQueueRepo = mock(() => ({ cancelForSessionWithMessages: cancelSpy }));
      mockDb.getSDKMessageRepo = mock(() => ({ markDeliveryFailedByUuid: markFailedSpy }));
      (mockDb.deleteSession as ReturnType<typeof mock>).mockImplementation(() => {
        order.push('db-delete');
      });

      await lifecycle.deleteResources('test-id', 'ui_session_delete');

      expect(mockDb.updateSession).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({ status: 'archived' })
      );
      expect(cancelSpy).toHaveBeenCalledWith('test-id');
      expect(markFailedSpy).toHaveBeenCalledWith('test-id', 'msg-uuid-1');
      expect(order).toEqual(['mark-archived', 'delivery-cancel', 'db-delete']);
    });

    it('should publish a failed status change for cancelled deliveries', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'delete-id',
        workspacePath: '/test',
        metadata: {},
      });
      mockDb.getJobQueueRepo = mock(() => ({
        cancelForSessionWithMessages: mock(() => ['msg-uuid-1', 'msg-uuid-2']),
      }));
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveryFailedByUuid: mock((_sessionId: string, uuid: string) => `db-${uuid}`),
      }));

      await lifecycle.deleteResources('delete-id', 'ui_session_delete');

      expect(mockInternalEventBus.publish).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'delete-id',
        messageIds: ['db-msg-uuid-1', 'db-msg-uuid-2'],
        status: 'failed',
      });
    });
  });

  describe('archiveResources (UI-only: session.archive + task.archive)', () => {
    it('should NOT delete the DB row — archive preserves conversation history', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'archive-id',
        workspacePath: '/test',
      });

      await lifecycle.archiveResources('archive-id', 'ui_session_archive');

      expect(mockDb.deleteSession).not.toHaveBeenCalled();
    });

    it('should still stop the in-memory SDK subprocess via AgentSession.cleanup', async () => {
      const mockAgentSession = {
        cleanup: mock(async () => {}),
        updateMetadata: mock(() => {}),
      };
      (mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
      (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'archive-id',
        workspacePath: '/test',
        metadata: {},
      });

      await lifecycle.archiveResources('archive-id', 'ui_session_archive');

      expect(mockAgentSession.cleanup).toHaveBeenCalled();
    });

    it('should stamp the session row as archived without deleting it', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'archive-id',
        workspacePath: '/test',
        metadata: {},
      });

      await lifecycle.archiveResources('archive-id', 'ui_session_archive');

      expect(mockDb.deleteSession).not.toHaveBeenCalled();
      expect(mockDb.updateSession).toHaveBeenCalled();
    });

    it('should publish a failed status change for cancelled deliveries', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'archive-id',
        workspacePath: '/test',
        metadata: {},
      });
      mockDb.getJobQueueRepo = mock(() => ({
        cancelForSessionWithMessages: mock(() => ['msg-uuid-1', 'msg-uuid-2']),
      }));
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveryFailedByUuid: mock((_sessionId: string, uuid: string) => `db-${uuid}`),
      }));

      await lifecycle.archiveResources('archive-id', 'ui_session_archive');

      expect(mockInternalEventBus.publish).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'archive-id',
        messageIds: ['db-msg-uuid-1', 'db-msg-uuid-2'],
        status: 'failed',
      });
    });
  });

  describe('completeWorktreeChoice', () => {
    let mockAgentSession: {
      getSessionData: ReturnType<typeof mock>;
      updateMetadata: ReturnType<typeof mock>;
    };

    beforeEach(() => {
      mockAgentSession = {
        getSessionData: mock(() => ({
          id: 'test-id',
          title: 'Test',
          workspacePath: '/test',
          status: 'pending_worktree_choice',
          metadata: {
            titleGenerated: true,
            worktreeChoice: {
              status: 'pending',
              createdAt: new Date().toISOString(),
            },
          },
          config: {},
          worktree: undefined,
        })),
        updateMetadata: mock(() => {}),
      };
      (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);
    });

    it('should throw error if session not found', async () => {
      (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(null);

      await expect(lifecycle.completeWorktreeChoice('nonexistent', 'worktree')).rejects.toThrow(
        'Session nonexistent not found'
      );
    });

    it('should throw error if session is not pending worktree choice', async () => {
      mockAgentSession.getSessionData.mockReturnValue({
        id: 'test-id',
        status: 'active',
        metadata: {},
        config: {},
      });

      await expect(lifecycle.completeWorktreeChoice('test-id', 'worktree')).rejects.toThrow(
        'is not pending worktree choice'
      );
    });

    it('should create worktree when choice is worktree', async () => {
      (mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockResolvedValue({
        worktreePath: '/test/worktree',
        branch: 'session/test-id',
        mainRepoPath: '/test/main',
      });

      await lifecycle.completeWorktreeChoice('test-id', 'worktree');

      expect(mockWorktreeManager.createWorktree).toHaveBeenCalled();
    });

    it('should not create worktree when choice is direct', async () => {
      await lifecycle.completeWorktreeChoice('test-id', 'direct');

      expect(mockWorktreeManager.createWorktree).not.toHaveBeenCalled();
    });

    it('should update session status to active', async () => {
      await lifecycle.completeWorktreeChoice('test-id', 'direct');

      expect(mockDb.updateSession).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          status: 'active',
        })
      );
    });

    it('should update worktreeChoice metadata', async () => {
      await lifecycle.completeWorktreeChoice('test-id', 'direct');

      expect(mockDb.updateSession).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          metadata: expect.objectContaining({
            worktreeChoice: expect.objectContaining({
              status: 'completed',
              choice: 'direct',
            }),
          }),
        })
      );
    });

    it('should force direct mode for non-worker sessions', async () => {
      mockAgentSession.getSessionData.mockReturnValue({
        id: 'test-id',
        type: 'space_chat',
        title: 'Test',
        workspacePath: '/test',
        status: 'pending_worktree_choice',
        metadata: {
          titleGenerated: true,
          worktreeChoice: {
            status: 'pending',
            createdAt: new Date().toISOString(),
          },
        },
        config: {},
        worktree: undefined,
      });

      await lifecycle.completeWorktreeChoice('test-id', 'worktree');

      expect(mockWorktreeManager.createWorktree).not.toHaveBeenCalled();
      expect(mockDb.updateSession).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          metadata: expect.objectContaining({
            worktreeChoice: expect.objectContaining({
              choice: 'direct',
            }),
          }),
        })
      );
    });

    it('should emit session.updated event', async () => {
      await lifecycle.completeWorktreeChoice('test-id', 'direct');

      expect(mockInternalEventBus.publish).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId: 'test-id',
        })
      );
    });
  });

  describe('getFromDB', () => {
    it('should return session from database', () => {
      const mockSession = { id: 'test-id', title: 'Test' };
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(mockSession);

      const result = lifecycle.getFromDB('test-id');

      expect(mockDb.getSession).toHaveBeenCalledWith('test-id');
      expect(result).toEqual(mockSession);
    });

    it('should return null if session not found', () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

      const result = lifecycle.getFromDB('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('markOutputRemoved', () => {
    it('should throw error if session not found', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue(null);

      await expect(lifecycle.markOutputRemoved('nonexistent', 'msg-uuid')).rejects.toThrow(
        'Session not found'
      );
    });

    it('should add messageUuid to removedOutputs', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        metadata: { removedOutputs: [] },
      });

      await lifecycle.markOutputRemoved('test-id', 'msg-uuid');

      expect(mockDb.updateSession).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          metadata: expect.objectContaining({
            removedOutputs: ['msg-uuid'],
          }),
        })
      );
    });

    it('should not add duplicate messageUuid', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        metadata: { removedOutputs: ['msg-uuid'] },
      });

      await lifecycle.markOutputRemoved('test-id', 'msg-uuid');

      expect(mockDb.updateSession).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          metadata: expect.objectContaining({
            removedOutputs: ['msg-uuid'],
          }),
        })
      );
    });

    it('should initialize removedOutputs if undefined', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        id: 'test-id',
        metadata: {},
      });

      await lifecycle.markOutputRemoved('test-id', 'msg-uuid');

      expect(mockDb.updateSession).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          metadata: expect.objectContaining({
            removedOutputs: ['msg-uuid'],
          }),
        })
      );
    });
  });
});

describe('generateBranchName', () => {
  it('should generate branch name from title', () => {
    const result = generateBranchName('Fix login bug', 'abc12345-6789');

    expect(result).toBe('session/fix-login-bug-abc12345');
  });

  it('should slugify title correctly', () => {
    const result = generateBranchName('Add Feature: User Authentication!!!', 'xyz98765-4321');

    expect(result).toBe('session/add-feature-user-authentication-xyz98765');
  });

  it('should truncate long titles', () => {
    const longTitle =
      'This is a very long title that should be truncated to prevent branch names from being too long';
    const result = generateBranchName(longTitle, 'abc12345-6789');

    expect(result.length).toBeLessThan(80);
    expect(result.startsWith('session/')).toBe(true);
  });

  it('should handle special characters', () => {
    const result = generateBranchName('Fix @#$%^& bug!', 'abc12345-6789');

    expect(result).toBe('session/fix-bug-abc12345');
  });

  it('should handle empty title', () => {
    const result = generateBranchName('', 'abc12345-6789');

    expect(result).toBe('session/-abc12345');
  });

  it('should handle unicode characters', () => {
    const result = generateBranchName('Fix 日本語 bug', 'abc12345-6789');

    expect(result).toBe('session/fix-bug-abc12345');
  });
});

describe('SessionLifecycle - generateTitleAndRenameBranch', () => {
  let lifecycle: SessionLifecycle;
  let mockDb: Database;
  let mockWorktreeManager: WorktreeManager;
  let mockSessionCache: SessionCache;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageHub: MessageHub;
  let mockToolsConfigManager: ToolsConfigManager;
  let mockAgentSessionFactory: AgentSessionFactory;
  let config: SessionLifecycleConfig;

  beforeEach(() => {
    mockDb = {
      createSession: mock(() => {}),
      updateSession: mock(() => {}),
      deleteSession: mock(() => {}),
      getSession: mock(() => null),
      getGlobalSettings: mock(() => ({
        ...DEFAULT_GLOBAL_SETTINGS,
        settingSources: ['user', 'project', 'local'],
      })),
    } as unknown as Database;

    mockWorktreeManager = {
      detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
      createWorktree: mock(async () => null),
      removeWorktree: mock(async () => {}),
      verifyWorktree: mock(async () => false),
      renameBranch: mock(async () => true),
      getCurrentBranch: mock(async () => 'main'),
    } as unknown as WorktreeManager;

    const mockAgentSession = {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => ({
        id: 'test-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        metadata: { titleGenerated: false, worktreeChoice: undefined },
        config: {},
        worktree: undefined,
      })),
    };
    mockSessionCache = {
      set: mock(() => {}),
      get: mock(() => mockAgentSession),
      has: mock(() => true),
      remove: mock(() => {}),
      clear: mock(() => {}),
      getAsync: mock(async () => mockAgentSession),
    } as unknown as SessionCache;

    mockInternalEventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    mockMessageHub = {
      event: mock(async () => {}),
      onRequest: mock(() => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    mockToolsConfigManager = {} as unknown as ToolsConfigManager;

    mockAgentSessionFactory = mock(() => mockAgentSession);

    config = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
      workspaceRoot: '/default/workspace',
      disableWorktrees: true,
    };

    lifecycle = new SessionLifecycle(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );
  });

  it('should return existing title if already generated', async () => {
    const mockAgentSession = {
      getSessionData: mock(() => ({
        id: 'test-id',
        title: 'Existing Title',
        workspacePath: '/test',
        status: 'active',
        metadata: { titleGenerated: true },
        config: {},
      })),
    };
    (mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'new message');

    expect(result.title).toBe('Existing Title');
    expect(result.isFallback).toBe(false);
  });

  it('should throw error if session not found', async () => {
    (mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(false);
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(null);

    await expect(lifecycle.generateTitleAndRenameBranch('nonexistent', 'message')).rejects.toThrow(
      'Session nonexistent not found'
    );
  });

  it('should rename branch when worktree exists', async () => {
    const mockAgentSession = {
      getSessionData: mock(() => ({
        id: 'test-id',
        title: 'New Session',
        workspacePath: '/test',
        status: 'active',
        metadata: { titleGenerated: false },
        config: {},
        worktree: {
          worktreePath: '/test/worktree',
          branch: 'session/test-id',
          mainRepoPath: '/test/main',
        },
      })),
      updateMetadata: mock(() => {}),
    };
    (mockSessionCache.has as ReturnType<typeof mock>).mockReturnValue(true);
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(mockAgentSession);

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'test message');

    expect(result).toBeDefined();
    expect(typeof result.title).toBe('string');
  });
});

describe('SessionLifecycle - completeWorktreeChoice edge cases', () => {
  let lifecycle: SessionLifecycle;
  let mockDb: Database;
  let mockWorktreeManager: WorktreeManager;
  let mockSessionCache: SessionCache;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageHub: MessageHub;
  let mockToolsConfigManager: ToolsConfigManager;
  let mockAgentSessionFactory: AgentSessionFactory;
  let config: SessionLifecycleConfig;

  beforeEach(() => {
    mockDb = {
      createSession: mock(() => {}),
      updateSession: mock(() => {}),
      deleteSession: mock(() => {}),
      getSession: mock(() => null),
      getGlobalSettings: mock(() => DEFAULT_GLOBAL_SETTINGS),
    } as unknown as Database;

    mockWorktreeManager = {
      detectGitSupport: mock(async () => ({ isGitRepo: true, isBare: false, gitRoot: '/test' })),
      createWorktree: mock(async () => ({
        worktreePath: '/test/worktree',
        branch: 'session/test-id',
        mainRepoPath: '/test/main',
      })),
      removeWorktree: mock(async () => {}),
      getCurrentBranch: mock(async () => 'main'),
    } as unknown as WorktreeManager;

    const mockAgentSession = {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => ({
        id: 'test-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'pending_worktree_choice',
        metadata: {
          titleGenerated: true,
          worktreeChoice: { status: 'pending', createdAt: new Date().toISOString() },
        },
        config: {},
      })),
    };

    mockSessionCache = {
      set: mock(() => {}),
      get: mock(() => mockAgentSession),
      has: mock(() => true),
      remove: mock(() => {}),
    } as unknown as SessionCache;

    mockInternalEventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    mockMessageHub = {
      event: mock(async () => {}),
    } as unknown as MessageHub;

    mockToolsConfigManager = {} as unknown as ToolsConfigManager;

    mockAgentSessionFactory = mock(() => mockAgentSession);

    config = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
      workspaceRoot: '/default/workspace',
    };

    lifecycle = new SessionLifecycle(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );
  });

  it('should detect current branch for direct mode', async () => {
    await lifecycle.completeWorktreeChoice('test-id', 'direct');

    expect(mockWorktreeManager.getCurrentBranch).toHaveBeenCalledWith('/test');
  });

  it('should handle branch detection failure gracefully', async () => {
    (mockWorktreeManager.getCurrentBranch as ReturnType<typeof mock>).mockRejectedValue(
      new Error('Not a git repo')
    );

    await lifecycle.completeWorktreeChoice('test-id', 'direct');
  });

  it('should handle worktree creation failure gracefully', async () => {
    (mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockResolvedValue(null);

    const result = await lifecycle.completeWorktreeChoice('test-id', 'worktree');

    expect(result.status).toBe('active');
  });
});

describe('SessionLifecycle - session creation with worktree', () => {
  let lifecycle: SessionLifecycle;
  let mockDb: Database;
  let mockWorktreeManager: WorktreeManager;
  let mockSessionCache: SessionCache;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageHub: MessageHub;
  let mockToolsConfigManager: ToolsConfigManager;
  let mockAgentSessionFactory: AgentSessionFactory;
  let config: SessionLifecycleConfig;

  beforeEach(() => {
    mockDb = {
      createSession: mock(() => {}),
      updateSession: mock(() => {}),
      deleteSession: mock(() => {}),
      getSession: mock(() => null),
      getGlobalSettings: mock(() => DEFAULT_GLOBAL_SETTINGS),
    } as unknown as Database;

    mockWorktreeManager = {
      detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
      createWorktree: mock(async () => ({
        worktreePath: '/test/worktree',
        branch: 'session/test-id',
        mainRepoPath: '/test/main',
      })),
      removeWorktree: mock(async () => {}),
      getCurrentBranch: mock(async () => 'main'),
    } as unknown as WorktreeManager;

    const mockAgentSession = {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => ({
        id: 'test-id',
        title: 'Test',
        workspacePath: '/test',
        status: 'active',
        metadata: {},
        config: {},
      })),
    };

    mockSessionCache = {
      set: mock(() => {}),
      get: mock(() => mockAgentSession),
      has: mock(() => false),
      remove: mock(() => {}),
    } as unknown as SessionCache;

    mockInternalEventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    mockMessageHub = {
      event: mock(async () => {}),
    } as unknown as MessageHub;

    mockToolsConfigManager = {} as unknown as ToolsConfigManager;

    mockAgentSessionFactory = mock(() => mockAgentSession);

    config = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
      workspaceRoot: '/default/workspace',
      disableWorktrees: false,
    };

    lifecycle = new SessionLifecycle(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );
  });

  it('should create worktree for non-git repos when worktrees enabled', async () => {
    await lifecycle.create({ title: 'Test Session', workspacePath: '/default/workspace' });

    expect(mockWorktreeManager.createWorktree).toHaveBeenCalled();
  });

  it('should handle worktree creation failure gracefully', async () => {
    (mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockRejectedValue(
      new Error('Worktree creation failed')
    );

    const sessionId = await lifecycle.create({
      title: 'Test Session',
      workspacePath: '/default/workspace',
    });

    expect(sessionId).toBeDefined();
  });

  it('should use title for branch name when title provided', async () => {
    await lifecycle.create({
      title: 'Feature Implementation',
      workspacePath: '/default/workspace',
    });

    expect(mockWorktreeManager.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: expect.stringContaining('feature-implementation'),
      })
    );
  });

  it('should use session ID for branch name when no title provided', async () => {
    await lifecycle.create({ workspacePath: '/default/workspace' });

    expect(mockWorktreeManager.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: expect.stringMatching(/^session\/[a-f0-9-]+$/),
      })
    );
  });
});

describe('SessionLifecycle - setWorkspace', () => {
  const SESSION_ID = 'test-session-id';

  let lifecycle: SessionLifecycle;
  let mockDb: Database;
  let mockWorktreeManager: WorktreeManager;
  let mockSessionCache: SessionCache;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageHub: MessageHub;
  let mockToolsConfigManager: ToolsConfigManager;
  let mockAgentSessionFactory: AgentSessionFactory;
  let config: SessionLifecycleConfig;

  beforeEach(() => {
    mockDb = {
      createSession: mock(() => {}),
      updateSession: mock(() => {}),
      deleteSession: mock(() => {}),
      getSession: mock(() => null),
      getGlobalSettings: mock(() => DEFAULT_GLOBAL_SETTINGS),
      isWorkspaceRegisteredToSpace: mock(() => true),
    } as unknown as Database;

    mockWorktreeManager = {
      detectGitSupport: mock(async () => ({ isGitRepo: false, gitRoot: null })),
      createWorktree: mock(async () => null),
      removeWorktree: mock(async () => {}),
      getCurrentBranch: mock(async () => 'main'),
    } as unknown as WorktreeManager;

    mockSessionCache = {
      set: mock(() => {}),
      get: mock(() => undefined),
      has: mock(() => false),
      remove: mock(() => {}),
      clear: mock(() => {}),
      getAsync: mock(async () => undefined),
    } as unknown as SessionCache;

    mockInternalEventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    mockMessageHub = {
      event: mock(async () => {}),
      onRequest: mock((_method: string, _handler: Function) => () => {}),
    } as unknown as MessageHub;

    mockToolsConfigManager = {} as unknown as ToolsConfigManager;

    mockAgentSessionFactory = mock(() => ({}));

    config = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
      disableWorktrees: true,
    };

    lifecycle = new SessionLifecycle(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );
  });

  function makeAgentSession(overrides: Record<string, unknown> = {}) {
    return {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => ({
        id: SESSION_ID,
        title: 'New Session',
        workspacePath: null,
        status: 'active',
        type: 'worker',
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
          titleGenerated: false,
          workspaceInitialized: false,
        },
        config: {},
        worktree: undefined,
        ...overrides,
      })),
    };
  }

  it('sets workspace path and marks as initialized for direct mode', async () => {
    const agentSession = makeAgentSession();
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct');

    expect(mockDb.updateSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        workspacePath: '/some/workspace',
        metadata: expect.objectContaining({
          workspaceInitialized: true,
          worktreeChoice: expect.objectContaining({
            status: 'completed',
            choice: 'direct',
          }),
        }),
      })
    );
  });

  it('creates a worktree when worktreeMode is worktree and worktrees enabled', async () => {
    const lifecycleWithWorktrees = new SessionLifecycle(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      { ...config, disableWorktrees: false },
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    const worktreeResult = {
      isWorktree: true as const,
      worktreePath: '/worktrees/test-session-id',
      mainRepoPath: '/some/workspace',
      branch: `session/${SESSION_ID}`,
    };
    (mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockResolvedValue(
      worktreeResult
    );

    const agentSession = makeAgentSession();
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await lifecycleWithWorktrees.setWorkspace(SESSION_ID, '/some/workspace', 'worktree');

    expect(mockWorktreeManager.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        repoPath: '/some/workspace',
        branchName: `session/${SESSION_ID}`,
      })
    );

    expect(mockDb.updateSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        workspacePath: '/some/workspace',
        worktree: worktreeResult,
        metadata: expect.objectContaining({
          workspaceInitialized: true,
          worktreeChoice: expect.objectContaining({
            status: 'completed',
            choice: 'worktree',
          }),
        }),
      })
    );
  });

  it('skips worktree creation when worktrees are globally disabled', async () => {
    const agentSession = makeAgentSession();
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'worktree');

    expect(mockWorktreeManager.createWorktree).not.toHaveBeenCalled();

    expect(mockDb.updateSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        workspacePath: '/some/workspace',
        worktree: undefined,
      })
    );
  });

  it('emits session.updated event after setting workspace', async () => {
    const agentSession = makeAgentSession();
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct');

    expect(mockInternalEventBus.publish).toHaveBeenCalledWith(
      'session.updated',
      expect.objectContaining({
        sessionId: SESSION_ID,
        session: expect.objectContaining({
          workspacePath: '/some/workspace',
        }),
      })
    );
  });

  it('throws when session is not found', async () => {
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(undefined);

    await expect(lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct')).rejects.toThrow(
      `Session ${SESSION_ID} not found`
    );
  });

  it('throws when session is not a worker type', async () => {
    const agentSession = makeAgentSession({ type: 'space_chat' });
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await expect(lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct')).rejects.toThrow(
      'is not a worker session'
    );
  });

  it('throws when session status is not active', async () => {
    const agentSession = makeAgentSession({ status: 'pending_worktree_choice' });
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await expect(lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct')).rejects.toThrow(
      'must be active to set workspace'
    );
  });

  it('throws when workspace path is empty', async () => {
    const agentSession = makeAgentSession();
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await expect(lifecycle.setWorkspace(SESSION_ID, '   ', 'direct')).rejects.toThrow(
      'Workspace path cannot be empty'
    );
  });

  it('throws when session already has a workspace (prevents silent overwrite)', async () => {
    const agentSession = makeAgentSession({ workspacePath: '/existing/workspace' });
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await expect(lifecycle.setWorkspace(SESSION_ID, '/new/workspace', 'direct')).rejects.toThrow(
      'already has a workspace'
    );
  });

  it('detects git branch for direct mode on git repos', async () => {
    (mockWorktreeManager.detectGitSupport as ReturnType<typeof mock>).mockResolvedValue({
      isGitRepo: true,
      gitRoot: '/some/workspace',
    });
    (mockWorktreeManager.getCurrentBranch as ReturnType<typeof mock>).mockResolvedValue('main');

    const agentSession = makeAgentSession();
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct');

    expect(mockWorktreeManager.getCurrentBranch).toHaveBeenCalledWith('/some/workspace');

    expect(mockDb.updateSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        gitBranch: 'main',
      })
    );
  });

  it('blocks setWorkspace when the spaceId is set and the workspace is unregistered', async () => {
    (mockDb.isWorkspaceRegisteredToSpace as ReturnType<typeof mock>).mockReturnValue(false);

    const agentSession = makeAgentSession({ context: { spaceId: 'space-1' } });
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await expect(lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct')).rejects.toThrow(
      'is not registered to space space-1'
    );

    expect(mockDb.updateSession).not.toHaveBeenCalled();
  });

  it('allows setWorkspace when the spaceId is set and the workspace is registered', async () => {
    const agentSession = makeAgentSession({ context: { spaceId: 'space-1' } });
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct');

    expect(mockDb.isWorkspaceRegisteredToSpace).toHaveBeenCalledWith('space-1', '/some/workspace');
    expect(mockDb.updateSession).toHaveBeenCalled();
  });

  it('skips the workspace ownership check when the session has no spaceId', async () => {
    const agentSession = makeAgentSession();
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await lifecycle.setWorkspace(SESSION_ID, '/some/workspace', 'direct');

    expect(mockDb.isWorkspaceRegisteredToSpace).not.toHaveBeenCalled();
  });

  it('re-checks registration after worktree creation and discards the worktree if it lapsed', async () => {
    const lifecycleWithWorktrees = new SessionLifecycle(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      { ...config, disableWorktrees: false },
      mockToolsConfigManager,
      mockAgentSessionFactory
    );
    (mockDb.isWorkspaceRegisteredToSpace as ReturnType<typeof mock>)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    (mockWorktreeManager.createWorktree as ReturnType<typeof mock>).mockResolvedValue({
      isWorktree: true,
      worktreePath: '/worktrees/test-session-id',
      mainRepoPath: '/some/workspace',
      branch: `session/${SESSION_ID}`,
    });

    const agentSession = makeAgentSession({ context: { spaceId: 'space-1' } });
    (mockSessionCache.get as ReturnType<typeof mock>).mockReturnValue(agentSession);

    await expect(
      lifecycleWithWorktrees.setWorkspace(SESSION_ID, '/some/workspace', 'worktree')
    ).rejects.toThrow('no longer registered to space space-1');

    expect(mockWorktreeManager.removeWorktree).toHaveBeenCalled();
    expect(mockDb.updateSession).not.toHaveBeenCalled();
  });
});
