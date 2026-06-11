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
function installSdkMock() {
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
}

installSdkMock();

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

import {
  SessionLifecycle,
  type SessionLifecycleConfig,
} from '../../../../src/lib/session/session-lifecycle';
import type { Database } from '../../../../src/storage/database';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { WorktreeManager } from '../../../../src/lib/worktree-manager';
import type { SessionCache, AgentSessionFactory } from '../../../../src/lib/session/session-cache';
import type { ToolsConfigManager } from '../../../../src/lib/session/tools-config';
import type { MessageHub } from '@neokai/shared';
import { DEFAULT_GLOBAL_SETTINGS } from '@neokai/shared';

describe('SessionLifecycle - generateTitleWithSdk (thinking disabled)', () => {
  let lifecycle: SessionLifecycle;
  let mockDb: Database;
  let mockWorktreeManager: WorktreeManager;
  let mockSessionCache: SessionCache;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockMessageHub: MessageHub;
  let mockToolsConfigManager: ToolsConfigManager;
  let mockAgentSessionFactory: AgentSessionFactory;
  let config: SessionLifecycleConfig;

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
    installSdkMock();
    const { resetProviderRegistry } = await import('../../../../src/lib/providers/registry');
    resetProviderRegistry();

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

    // Set a fake API key so the real provider service proceeds past the key
    // check and calls generateTitleWithSdk. Cleared in afterEach.
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

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

  afterEach(async () => {
    const { resetProviderRegistry } = await import('../../../../src/lib/providers/registry');
    resetProviderRegistry();
    // Restore the empty API key set by unit-test setup.ts
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GLM_API_KEY = '';
  });

  it('should disable thinking when calling SDK query for title generation', async () => {
    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(false);
    expect(lastTitleQueryOptions).toBeDefined();
    expect(lastTitleQueryOptions?.thinking).toEqual({ type: 'disabled' });
  });

  it('should pass the session model to SDK title generation without provider hardcoding', async () => {
    await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(lastTitleQueryOptions?.model).toBe('claude-sonnet-4-20250514');
  });

  it('should build title routing env from provider title model override', async () => {
    const { GlmProvider } = await import('../../../../src/lib/providers/glm-provider');
    const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');

    process.env.GLM_API_KEY = 'test-glm-key';
    const registry = getProviderRegistry();
    registry.register(new GlmProvider(process.env));

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
    lifecycle = new SessionLifecycle(
      mockDb,
      mockWorktreeManager,
      sessionCache,
      mockInternalEventBus,
      mockMessageHub,
      config,
      mockToolsConfigManager,
      mockAgentSessionFactory
    );

    await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

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
    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(false);
    expect(result.title).toBe('My Generated Title');
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

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(false);
    expect(result.title).toBe('Bold Title Here');
  });

  it('should fall back to message text when assistant message contains only thinking blocks', async () => {
    // Regression test for the original bug: models with adaptive thinking (e.g. Opus 4.6)
    // may return an assistant message whose content array contains only thinking blocks with
    // no text block. Without `thinking: { type: 'disabled' }` in the query options, this
    // caused a "No text content in SDK response" error. With the fix in place, this scenario
    // cannot occur in production, but the defensive fallback path should still work correctly.
    mockSdkMessages = [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'Long internal reasoning about the title...' }],
        },
      },
    ];

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(true);
    expect(result.title).toBe('Create a login form');
  });

  it('should fall back to message text when SDK returns no assistant messages', async () => {
    mockSdkMessages = [{ type: 'result', subtype: 'success' }];

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(true);
    expect(result.title).toBe('Create a login form');
  });

  it('should generate titles using stored credentials when env vars are absent', async () => {
    const { AnthropicProvider } = await import('../../../../src/lib/providers/anthropic-provider');
    const { getProviderRegistry } = await import('../../../../src/lib/providers/registry');

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    const anthropicProvider = new AnthropicProvider();
    anthropicProvider.setCredentials({ type: 'api_key', apiKey: 'stored-api-key' });
    const registry = getProviderRegistry();
    registry.register(anthropicProvider);

    const result = await lifecycle.generateTitleAndRenameBranch('test-id', 'Create a login form');

    expect(result.isFallback).toBe(false);
    expect(result.title).toBe('My Generated Title');
  });
});
