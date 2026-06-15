/**
 * SDK Title Generation Tests
 *
 * Tests for the generateTitleWithSdk private method, covering:
 * - Thinking is disabled to prevent models with adaptive thinking from
 *   returning thinking-only responses (the root cause of the bug fixed in
 *   session/sdk-title-generation-empty-response-error)
 * - Title is correctly extracted from text blocks
 * - Fallback path is used when SDK call fails
 *
 * Design note: only the external @anthropic-ai/claude-agent-sdk package is
 * mocked here. Internal modules (provider-service, sdk-cli-resolver, etc.) use
 * their real implementations to avoid global mock pollution that would break
 * other test files sharing the same bun test process.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';

// Track query call options to verify what is passed to the SDK.
// Only updated on calls that carry a `thinking` option (title generation),
// not on model-loading calls (maxTurns: 0).
let lastTitleQueryOptions: Record<string, unknown> | undefined;
let lastTitleProcessEnv: Record<string, string | undefined> | undefined;

// Mutable state controlling which messages the SDK query mock yields for
// title generation. Set in beforeEach so each test starts from a known state.
let mockSdkMessages: unknown[] = [];
const mockProviderService = {
  isProviderAvailable: mock(async () => true),
  getTitleGenerationModels: mock(async (provider: string, modelId: string) => ({
    sdkModelId: provider === 'glm' ? 'default' : modelId,
    providerModelId: provider === 'glm' ? 'glm-5-turbo' : modelId,
  })),
  applyEnvVarsToProcessForProvider: mock(async (provider: string, providerModelId: string) => {
    const original = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    };
    if (provider === 'glm') {
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = providerModelId;
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = providerModelId;
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = providerModelId;
    }
    return original;
  }),
  getEnvVarsForModel: mock(async (modelId: string, provider: string) =>
    provider === 'glm'
      ? {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
          ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
          ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
        }
      : {}
  ),
  restoreEnvVars: mock((original: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }),
};

async function* makeAsyncGen(messages: unknown[]) {
  for (const msg of messages) {
    yield msg;
  }
}

/**
 * Build a Query-compatible mock from a message list.
 *
 * The returned object is an async iterable (for the title-generation loop) and
 * also exposes the `supportedModels()` / `interrupt()` methods that
 * loadModelsFromSdk() calls when loading the available model list.
 */
function makeQueryMock(messages: unknown[]) {
  const gen = makeAsyncGen(messages);
  return Object.assign(gen, {
    supportedModels: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(),
  });
}

// Only mock.module calls for EXTERNAL packages are placed at the top level.
// Mocking internal relative-import modules here would permanently replace
// them for ALL test files in the same bun test run, breaking tests that
// import those modules directly (e.g. provider-service.test.ts).
class MockMcpServerForSdk {
  readonly _registeredTools: Record<string, object> = {};
  connect(): void {}
  disconnect(): void {}
}
let _toolBatch: Array<{ name: string; def: object }> = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options?: Record<string, unknown> }) => {
    const opts = params.options ?? {};
    // Capture options only from the title-generation call, which is the one
    // that carries thinking: { type: 'disabled' }. Model-loading calls use
    // maxTurns: 0 with no thinking option and are not interesting here.
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

mock.module('../../../../src/lib/provider-service', () => ({
  getProviderService: () => mockProviderService,
  resetProviderServiceInstance: mock(() => {}),
  mergeProviderEnvVars: (env: Record<string, string | undefined>) => ({ ...process.env, ...env }),
}));

mock.module('@neokai/shared/sdk/type-guards', () => ({
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

import type {
  SessionLifecycle,
  SessionLifecycleConfig,
} from '../../../../src/lib/session/session-lifecycle';
import type { Database } from '../../../../src/storage/database';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { WorktreeManager } from '../../../../src/lib/worktree-manager';
import type { SessionCache, AgentSessionFactory } from '../../../../src/lib/session/session-cache';
import type { ToolsConfigManager } from '../../../../src/lib/session/tools-config';
import type { MessageHub } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

type TitleSdkInvoker = {
  generateTitleWithSdk(provider: string, modelId: string, messageText: string): Promise<string>;
};

function runTitleSdk(
  lifecycle: SessionLifecycle,
  provider = 'anthropic',
  modelId = 'claude-sonnet-4-20250514',
  messageText = 'Create a login form'
): Promise<string> {
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
        ) => Promise<string>;
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
    // Set API key before provider construction/registration so CI Bun versions
    // that snapshot process.env during provider setup still see credentials.
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    resetProviderRegistry();
    resetProviderFactory();
    resetProviderServiceInstance();
    const anthropicProvider = new AnthropicProvider(process.env);
    anthropicProvider.setCredentials({ type: 'api_key', apiKey: 'test-api-key' });
    getProviderRegistry().register(anthropicProvider);

    lastTitleQueryOptions = undefined;
    lastTitleProcessEnv = undefined;
    // Default: assistant message with a plain text block
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

    // (no methods are called by SessionLifecycle post-M5; an empty stub is
    // sufficient for type compatibility).
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
    // Restore the empty API key set by unit-test setup.ts
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
    expect(lastTitleProcessEnv?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo');
    expect(lastTitleProcessEnv?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo');
    expect(lastTitleProcessEnv?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5-turbo');
    const env = lastTitleQueryOptions?.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5-turbo');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5-turbo');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5-turbo');
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
    // Regression test for the original bug: models with adaptive thinking (e.g. Opus 4.6)
    // may return an assistant message whose content array contains only thinking blocks with
    // no text block. Without `thinking: { type: 'disabled' }` in the query options, this
    // caused a "No text content in SDK response" error. With the fix in place, this scenario
    // cannot occur in production, but the defensive fallback path should still work correctly.
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

  it('should generate titles using stored credentials when env vars are absent', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    const title = await generateTitleWithSdkForTest();

    expect(title).toBe('My Generated Title');
  });
});
