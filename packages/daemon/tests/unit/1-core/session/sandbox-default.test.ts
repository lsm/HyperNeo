import { beforeEach, describe, expect, it, mock } from 'bun:test';

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

import type { MessageHub } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { AgentSessionFactory, SessionCache } from '../../../../src/lib/session/session-cache';
import {
  SessionLifecycle,
  type SessionLifecycleConfig,
} from '../../../../src/lib/session/session-lifecycle';
import type { ToolsConfigManager } from '../../../../src/lib/session/tools-config';
import type { WorktreeManager } from '../../../../src/lib/worktree-manager';
import type { Database } from '../../../../src/storage/database';

describe('Sandbox Default Configuration', () => {
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
    const createSessionSpy = mock(() => {});
    mockDb = {
      createSession: createSessionSpy,
      updateSession: mock(() => {}),
      deleteSession: mock(() => {}),
      getSession: mock(() => null),
      getGlobalSettings: mock(() => ({
        settingSources: ['user', 'project', 'local'],
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          excludedCommands: ['git'],
          network: {
            allowedDomains: ['github.com', '*.github.com', '*.npmjs.org', '*.yarnpkg.com'],
            allowLocalBinding: true,
            allowAllUnixSockets: true,
          },
        },
      })),
    } as unknown as Database;

    mockWorktreeManager = {
      detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
      createWorktree: mock(async () => null),
      removeWorktree: mock(async () => {}),
      verifyWorktree: mock(async () => false),
      renameBranch: mock(async () => true),
    } as unknown as WorktreeManager;

    const mockAgentSession = {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => ({
        id: 'test-id',
        title: 'Test',
        workspacePath: '/test',
        metadata: { titleGenerated: false },
      })),
    };
    const cacheSetSpy = mock(() => {});
    mockSessionCache = {
      set: cacheSetSpy,
      get: mock(() => mockAgentSession),
      has: mock(() => false),
      remove: mock(() => {}),
      clear: mock(() => {}),
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
      defaultModel: 'default',
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

  describe('default sandbox configuration', () => {
    it('should enable sandbox by default', async () => {
      await lifecycle.create({});

      const createSessionSpy = mockDb.createSession as ReturnType<typeof mock>;
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sandbox: expect.objectContaining({
              enabled: true,
            }),
          }),
        }),
        expect.anything()
      );
    });

    it('should set autoAllowBashIfSandboxed to true by default', async () => {
      await lifecycle.create({});

      const createSessionSpy = mockDb.createSession as ReturnType<typeof mock>;
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sandbox: expect.objectContaining({
              autoAllowBashIfSandboxed: true,
            }),
          }),
        }),
        expect.anything()
      );
    });

    it('should exclude git from sandbox by default (SSH, submodules, various git hosts)', async () => {
      await lifecycle.create({});

      const createSessionSpy = mockDb.createSession as ReturnType<typeof mock>;
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sandbox: expect.objectContaining({
              excludedCommands: expect.arrayContaining(['git']),
            }),
          }),
        }),
        expect.anything()
      );
    });

    it('should allow network access to common development domains', async () => {
      await lifecycle.create({});

      const createSessionSpy = mockDb.createSession as ReturnType<typeof mock>;
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sandbox: expect.objectContaining({
              network: expect.objectContaining({
                allowedDomains: expect.arrayContaining([
                  'github.com',
                  '*.npmjs.org',
                  '*.yarnpkg.com',
                ]),
                allowLocalBinding: true,
                allowAllUnixSockets: true,
              }),
            }),
          }),
        }),
        expect.anything()
      );
    });
  });

  describe('sandbox override capability', () => {
    it('should allow disabling sandbox via config', async () => {
      await lifecycle.create({
        config: {
          sandbox: {
            enabled: false,
          },
        },
      });

      const createSessionSpy = mockDb.createSession as ReturnType<typeof mock>;
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sandbox: expect.objectContaining({
              enabled: false,
            }),
          }),
        }),
        expect.anything()
      );
    });

    it('should allow customizing sandbox settings', async () => {
      await lifecycle.create({
        config: {
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: false,
            excludedCommands: ['git', 'npm'],
          },
        },
      });

      const createSessionSpy = mockDb.createSession as ReturnType<typeof mock>;
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: false,
              excludedCommands: ['git', 'npm'],
            },
          }),
        }),
        expect.anything()
      );
    });

    it('should allow network sandbox configuration', async () => {
      await lifecycle.create({
        config: {
          sandbox: {
            enabled: true,
            network: {
              allowedDomains: ['api.example.com', 'registry.npmjs.org'],
            },
          },
        },
      });

      const createSessionSpy = mockDb.createSession as ReturnType<typeof mock>;
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sandbox: expect.objectContaining({
              network: {
                allowedDomains: ['api.example.com', 'registry.npmjs.org'],
              },
            }),
          }),
        }),
        expect.anything()
      );
    });
  });

  describe('sandbox with other config', () => {
    it('should not interfere with other config options', async () => {
      await lifecycle.create({
        config: {
          model: 'opus',
          maxTokens: 4096,
          coordinatorMode: true,
          thinkingLevel: 'think32k',
        },
      });

      const createSessionSpy = mockDb.createSession as ReturnType<typeof mock>;
      expect(createSessionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: 'opus',
            maxTokens: 4096,
            coordinatorMode: true,
            thinkingLevel: 'think32k',
            sandbox: expect.objectContaining({
              enabled: true,
              autoAllowBashIfSandboxed: true,
              network: expect.objectContaining({
                allowLocalBinding: true,
                allowAllUnixSockets: true,
              }),
            }),
          }),
        }),
        expect.anything()
      );
    });
  });
});
