import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let lastTitleQueryOptions: Record<string, unknown> | undefined;
let lastTitleProcessEnv: Record<string, string | undefined> | undefined;

let mockSdkMessages: unknown[] = [];

async function* makeAsyncGen(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

function makeQueryMock(messages: unknown[]) {
  const gen = makeAsyncGen(messages);
  return Object.assign(gen, {
    supportedModels: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(),
  });
}

class MockMcpServerForSdk {
  readonly _registeredTools: Record<string, object> = {};
  connect(): void {}
  disconnect(): void {}
}
let _toolBatch: Array<{ name: string; def: object }> = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options?: Record<string, unknown> }) => {
    const opts = params.options ?? {};
    if ('thinking' in opts) {
      lastTitleQueryOptions = opts;
      lastTitleProcessEnv = {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      };
    }
    return makeQueryMock(mockSdkMessages);
  },
  interrupt: mock(async () => {}),
  supportedModels: mock(async () => {
    throw new Error('SDK unavailable in unit test');
  }),
  createSdkMcpServer: mock((_options: { name: string; tools?: unknown[] }) => {
    const server = new MockMcpServerForSdk();
    for (const { name, def } of _toolBatch) {
      server._registeredTools[name] = def;
    }
    _toolBatch = [];
    return {
      type: 'sdk' as const,
      name: _options.name,
      version: _options.version ?? '1.0.0',
      tools: _options.tools ?? [],
      instance: server,
    };
  }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => {
    const def = { name, description, inputSchema, handler };
    _toolBatch.push({ name, def });
    return def;
  },
}));

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
import { DEFAULT_GLOBAL_SETTINGS } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { AgentSessionFactory, SessionCache } from '../../../../src/lib/session/session-cache';
import type {
  SessionLifecycle,
  SessionLifecycleConfig,
} from '../../../../src/lib/session/session-lifecycle';
import type { ToolsConfigManager } from '../../../../src/lib/session/tools-config';
import type { WorktreeManager } from '../../../../src/lib/worktree-manager';
import type { Database } from '../../../../src/storage/database';

type TitleSdkInvoker = {
  generateTitleWithSdk(
    provider: string,
    modelId: string,
    messageText: string
  ): Promise<string | null>;
};

function runTitleSdk(
  lifecycle: SessionLifecycle,
  provider = 'anthropic',
  modelId = 'claude-sonnet-4-20250514',
  messageText = 'Create a login form'
): Promise<string | null> {
  return (lifecycle as unknown as TitleSdkInvoker).generateTitleWithSdk(
    provider,
    modelId,
    messageText
  );
}

describe('SessionLifecycle - generateTitleWithSdk (thinking disabled)', () => {
  let SessionLifecycleCtor: typeof SessionLifecycle;
  let lifecycle: SessionLifecycle;
  let mockDb: Database;
  let mockWorktreeManager: WorktreeManager;
  let mockSessionCache: SessionCache;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageHub: MessageHub;
  let mockToolsConfigManager: ToolsConfigManager;
  let mockAgentSessionFactory: AgentSessionFactory;
  let mockTitleProviderService: NonNullable<
    SessionLifecycleConfig['titleGenerationProviderServiceForTesting']
  >;
  let config: SessionLifecycleConfig;

  const generateTitleWithSdkForTest = (
    provider = 'anthropic',
    modelId = 'claude-sonnet-4-20250514',
    messageText = 'Create a login form'
  ) =>
    (
      lifecycle as unknown as {
        generateTitleWithSdk: (
          provider: string,
          modelId: string,
          messageText: string
        ) => Promise<string | null>;
      }
    ).generateTitleWithSdk(provider, modelId, messageText);

  const makeSessionCache = () => {
    const mockAgentSession = {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => ({
        id: 'test-id',
        title: 'New Session',
        workspacePath: '/test',
        status: 'active',
        metadata: { titleGenerated: false, worktreeChoice: undefined },
        config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        worktree: undefined,
      })),
    };
    return {
      mockAgentSession,
      mockSessionCache: {
        set: mock(() => {}),
        get: mock(() => mockAgentSession),
        has: mock(() => true),
        remove: mock(() => {}),
        clear: mock(() => {}),
        getAsync: mock(async () => mockAgentSession),
      } as unknown as SessionCache,
    };
  };

  beforeEach(async () => {
    const { getProviderRegistry, resetProviderRegistry } = await import(
      '../../../../src/lib/providers/registry.js'
    );
    const { resetProviderFactory } = await import('../../../../src/lib/providers/factory.js');
    const { AnthropicProvider } = await import(
      '../../../../src/lib/providers/anthropic-provider.js'
    );
    const { resetProviderServiceInstance } = await import('../../../../src/lib/provider-service');
    const { SessionLifecycle } = await import('../../../../src/lib/session/session-lifecycle.js');
    SessionLifecycleCtor = SessionLifecycle;
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    resetProviderRegistry();
    resetProviderFactory();
    resetProviderServiceInstance();
    const anthropicProvider = new AnthropicProvider(process.env);
    anthropicProvider.setCredentials({ type: 'api_key', apiKey: 'test-api-key' });
    getProviderRegistry().register(anthropicProvider);

    lastTitleQueryOptions = undefined;
    lastTitleProcessEnv = undefined;
    mockSdkMessages = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'My Generated Title' }],
        },
      },
    ];

    const titleQueryOverride: SessionLifecycleConfig['titleGenerationQueryForTesting'] = (
      params
    ) => {
      const opts = params.options ?? {};
      if ('thinking' in opts) {
        lastTitleQueryOptions = opts;
        lastTitleProcessEnv = {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        };
      }
      return makeQueryMock(mockSdkMessages);
    };

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

    const { mockAgentSession, mockSessionCache: sessionCache } = makeSessionCache();
    mockSessionCache = sessionCache;
    mockAgentSessionFactory = mock(() => mockAgentSession) as unknown as AgentSessionFactory;

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

    mockTitleProviderService = {
      getDefaultProvider: mock(async () => 'anthropic'),
      isProviderAvailable: mock(async () => true),
      getTitleGenerationConfig: mock(async () => ({
        modelId: 'claude-sonnet-4-20250514',
        baseUrl: 'https://api.anthropic.com',
        apiVersion: 'v1',
      })),
      getTitleGenerationModels: mock(async (provider: string, sessionModelId: string) =>
        provider === 'glm'
          ? { providerModelId: 'glm-5-turbo', sdkModelId: 'default' }
          : { providerModelId: sessionModelId, sdkModelId: sessionModelId }
      ),
      applyEnvVarsToProcessForProvider: mock(async (provider: string) => {
        const original = {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        };
        if (provider === 'glm') {
          process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-5-turbo';
          process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5-turbo';
          process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5-turbo';
        }
        return original;
      }),
      getEnvVarsForModel: mock(async (_modelId: string, provider: string) =>
        provider === 'glm'
          ? {
              ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5-turbo',
              ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5-turbo',
              ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5-turbo',
            }
          : {}
      ),
      restoreEnvVars: mock((original) => {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
    };

    config = {
      defaultModel: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      temperature: 1.0,
      workspaceRoot: '/default/workspace',
      disableWorktrees: true,
      titleGenerationQueryForTesting: titleQueryOverride,
      titleGenerationProviderServiceForTesting: mockTitleProviderService,
    };

    lifecycle = new SessionLifecycleCtor(
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

  afterEach(async () => {
    const { resetProviderRegistry } = await import('../../../../src/lib/providers/registry.js');
    const { resetProviderFactory } = await import('../../../../src/lib/providers/factory.js');
    const { resetProviderServiceInstance } = await import('../../../../src/lib/provider-service');
    resetProviderRegistry();
    resetProviderFactory();
    resetProviderServiceInstance();
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GLM_API_KEY = '';
  });

  it('should disable thinking when calling SDK query for title generation', async () => {
    const title = await generateTitleWithSdkForTest();

    expect(title).toBe('My Generated Title');
    expect(lastTitleQueryOptions).toBeDefined();
    expect(lastTitleQueryOptions?.thinking).toEqual({ type: 'disabled' });
  });

  it('should pass the session model to SDK title generation without provider hardcoding', async () => {
    await generateTitleWithSdkForTest();

    expect(lastTitleQueryOptions?.model).toBe('claude-sonnet-4-20250514');
  });

  it('should build title routing env from provider title model override', async () => {
    process.env.GLM_API_KEY = 'test-glm-key';

    const { mockAgentSession, mockSessionCache: sessionCache } = makeSessionCache();
    mockAgentSession.getSessionData = mock(() => ({
      id: 'test-id',
      title: 'New Session',
      workspacePath: '/test',
      status: 'active',
      metadata: { titleGenerated: false, worktreeChoice: undefined },
      config: { model: 'glm-5.1', provider: 'glm' },
      worktree: undefined,
    }));
    lifecycle = new SessionLifecycleCtor(
      mockDb,
      mockWorktreeManager,
      sessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    await generateTitleWithSdkForTest('glm', 'glm-5.1');

    expect(lastTitleQueryOptions?.model).toBe('default');
    expect(lastTitleProcessEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(lastTitleProcessEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(lastTitleProcessEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    const env = lastTitleQueryOptions?.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5-turbo');
  });

  it('restores the applied provider env before invoking the SDK query', async () => {
    const events: string[] = [];
    mockTitleProviderService.applyEnvVarsToProcessForProvider = mock(async () => {
      events.push('apply');
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-5-turbo';
      return { ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined };
    });
    mockTitleProviderService.restoreEnvVars = mock((original) => {
      events.push(`restore:${Object.keys(original).length}`);
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    config.titleGenerationQueryForTesting = (params) => {
      const opts = params.options ?? {};
      if ('thinking' in opts) {
        lastTitleQueryOptions = opts;
        events.push(`query:${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'restored'}`);
      }
      return makeQueryMock(mockSdkMessages);
    };

    const title = await generateTitleWithSdkForTest('glm', 'glm-5.1');

    expect(title).toBe('My Generated Title');
    expect(events).toEqual(['apply', 'restore:1', 'query:restored', 'restore:0']);
    const env = lastTitleQueryOptions?.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo');
  });

  it('should extract title from text blocks', async () => {
    const title = await generateTitleWithSdkForTest();

    expect(title).toBe('My Generated Title');
  });

  it('should strip markdown formatting from extracted title', async () => {
    mockSdkMessages = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '**Bold Title Here**' }],
        },
      },
    ];

    const title = await generateTitleWithSdkForTest();

    expect(title).toBe('Bold Title Here');
  });

  it('should fall back to message text when assistant message contains only thinking blocks', async () => {
    const thinkingOnlyQuery: SessionLifecycleConfig['titleGenerationQueryForTesting'] = (
      params
    ) => {
      const opts = params.options ?? {};
      if ('thinking' in opts) lastTitleQueryOptions = opts;
      return makeQueryMock([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'thinking', thinking: 'Long internal reasoning about the title...' }],
          },
        },
      ]);
    };
    config.titleGenerationQueryForTesting = thinkingOnlyQuery;
    lifecycle = new SessionLifecycleCtor(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(true);
    expect(result.title).toBe('Create a login form');
  });

  it('should fall back to message text when SDK returns no assistant messages', async () => {
    const noAssistantQuery: SessionLifecycleConfig['titleGenerationQueryForTesting'] = (params) => {
      const opts = params.options ?? {};
      if ('thinking' in opts) lastTitleQueryOptions = opts;
      return makeQueryMock([{ type: 'result', subtype: 'success' }]);
    };
    config.titleGenerationQueryForTesting = noAssistantQuery;
    lifecycle = new SessionLifecycleCtor(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(true);
    expect(result.title).toBe('Create a login form');
  });

  it('should fall back to message text when the provider has no visible models', async () => {
    mockTitleProviderService.getTitleGenerationModels = mock(async () => null);
    lifecycle = new SessionLifecycleCtor(
      mockDb,
      mockWorktreeManager,
      mockSessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(true);
    expect(result.title).toBe('Create a login form');
    expect(lastTitleQueryOptions).toBeUndefined();
  });

  it('should skip auto-title generation when a user has manually renamed the session', async () => {
    const { mockAgentSession, mockSessionCache: sessionCache } = makeSessionCache();
    mockAgentSession.getSessionData = mock(() => ({
      id: 'test-id',
      title: 'My Renamed Title',
      workspacePath: '/test',
      status: 'active',
      metadata: { titleGenerated: false, titleSetBy: 'user' },
      config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      worktree: undefined,
    }));
    lifecycle = new SessionLifecycleCtor(
      mockDb,
      mockWorktreeManager,
      sessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.title).toBe('My Renamed Title');
    expect(result.isFallback).toBe(false);
    expect(lastTitleQueryOptions).toBeUndefined();
    expect(mockDb.updateSession).not.toHaveBeenCalled();
  });

  it('does not clobber a manual rename that lands during title generation', async () => {
    const { mockAgentSession, mockSessionCache: sessionCache } = makeSessionCache();
    mockAgentSession.getSessionData = mock(() => ({
      id: 'test-id',
      title: 'New Session',
      workspacePath: '/test',
      status: 'active',
      metadata: { titleGenerated: false },
      config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      worktree: undefined,
    }));
    const renameDuringQuery: SessionLifecycleConfig['titleGenerationQueryForTesting'] = (
      params
    ) => {
      const opts = params.options ?? {};
      if ('thinking' in opts) lastTitleQueryOptions = opts;
      mockAgentSession.getSessionData = mock(() => ({
        id: 'test-id',
        title: 'My Manual Title',
        workspacePath: '/test',
        status: 'active',
        metadata: { titleGenerated: false, titleSetBy: 'user' },
        config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        worktree: undefined,
      }));
      return makeQueryMock(mockSdkMessages);
    };
    config.titleGenerationQueryForTesting = renameDuringQuery;
    lifecycle = new SessionLifecycleCtor(
      mockDb,
      mockWorktreeManager,
      sessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.title).toBe('My Manual Title');
    expect(result.isFallback).toBe(false);
    expect(mockDb.updateSession).not.toHaveBeenCalled();
  });

  it('does not overwrite a manual rename when the fallback path runs', async () => {
    const { mockAgentSession, mockSessionCache: sessionCache } = makeSessionCache();
    mockAgentSession.getSessionData = mock(() => ({
      id: 'test-id',
      title: 'New Session',
      workspacePath: '/test',
      status: 'active',
      metadata: { titleGenerated: false },
      config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      worktree: { path: '/w', branch: 'session/test-id', mainRepoPath: '/repo' },
    }));
    mockWorktreeManager.renameBranch = mock(async () => {
      mockAgentSession.getSessionData = mock(() => ({
        id: 'test-id',
        title: 'My Manual Title',
        workspacePath: '/test',
        status: 'active',
        metadata: { titleGenerated: false, titleSetBy: 'user' },
        config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        worktree: { path: '/w', branch: 'session/test-id', mainRepoPath: '/repo' },
      }));
      throw new Error('git rename failed');
    });
    lifecycle = new SessionLifecycleCtor(
      mockDb,
      mockWorktreeManager,
      sessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.title).toBe('My Manual Title');
    expect(result.isFallback).toBe(false);
    expect(mockDb.updateSession).not.toHaveBeenCalled();
  });

  it('preserves a manual rename that lands during the branch rename', async () => {
    const { mockAgentSession, mockSessionCache: sessionCache } = makeSessionCache();
    mockAgentSession.getSessionData = mock(() => ({
      id: 'test-id',
      title: 'New Session',
      workspacePath: '/test',
      status: 'active',
      metadata: { titleGenerated: false },
      config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      worktree: { path: '/w', branch: 'session/test-id', mainRepoPath: '/repo' },
    }));
    mockWorktreeManager.renameBranch = mock(async () => {
      mockAgentSession.getSessionData = mock(() => ({
        id: 'test-id',
        title: 'My Manual Title',
        workspacePath: '/test',
        status: 'active',
        metadata: { titleGenerated: false, titleSetBy: 'user' },
        config: { model: 'claude-sonnet-4-20250514', provider: 'anthropic' },
        worktree: { path: '/w', branch: 'session/test-id', mainRepoPath: '/repo' },
      }));
      return true;
    });
    lifecycle = new SessionLifecycleCtor(
      mockDb,
      mockWorktreeManager,
      sessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.title).toBe('My Manual Title');
    expect(result.isFallback).toBe(false);
    expect(mockDb.updateSession).toHaveBeenCalledTimes(1);
    const [, written] = mockDb.updateSession.mock.calls[0];
    expect(written.title).toBe('My Manual Title');
    expect(written.metadata.titleSetBy).toBe('user');
    expect(written.worktree?.branch).not.toBe('session/test-id');
  });

  it('should generate titles using stored credentials when env vars are absent', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    const title = await generateTitleWithSdkForTest();

    expect(title).toBe('My Generated Title');
  });
});
