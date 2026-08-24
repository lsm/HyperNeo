import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import { homedir } from 'os';
import {
  buildProviderSettings,
  ensureAgentTools,
  QueryOptionsBuilder,
  type QueryOptionsBuilderContext,
} from '../../../../src/lib/agent/query-options-builder';
import {
  SDK_TRANSCRIPT_RETENTION_DAYS,
  withSdkTranscriptRetention,
} from '../../../../src/lib/agent/sdk-transcript-retention';
import { setModelsCache } from '../../../../src/lib/model-service';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import { SkillsManager } from '../../../../src/lib/skills-manager';
import { LONG_HORIZON_AGENT_BUILTIN_TOOLS } from '../../../../src/lib/space/agents/long-horizon-agent-tools';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import { SkillRepository } from '../../../../src/storage/repositories/skill-repository';
import { createTables } from '../../../../src/storage/schema';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { noOpReactiveDb } from '../../../helpers/reactive-database';

describe('QueryOptionsBuilder', () => {
  let builder: QueryOptionsBuilder;
  let mockSession: Session;
  let mockSettingsManager: SettingsManager;
  let mockContext: QueryOptionsBuilderContext;
  let updateSessionSpy: ReturnType<typeof mock>;
  let getSDKMessagesSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSession = {
      id: generateUUID(),
      title: 'Test Session',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'default',
        maxTokens: 8192,
        temperature: 1.0,
        provider: 'anthropic',
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

    mockSettingsManager = {
      getGlobalSettings: mock(() => ({
        settingSources: ['user', 'project', 'local'],
        outputLimiter: { enabled: false },
        sandbox: { excludedCommands: ['git'] },
      })),
      prepareSDKOptions: mock(async () => ({})),
    } as unknown as SettingsManager;

    updateSessionSpy = mock(() => {});
    getSDKMessagesSpy = mock(() => ({ messages: [], hasMore: false }));

    mockContext = {
      session: mockSession,
      settingsManager: mockSettingsManager,
      db: {
        updateSession: updateSessionSpy,
        getSDKMessages: getSDKMessagesSpy,
      } as QueryOptionsBuilderContext['db'],
    };

    builder = new QueryOptionsBuilder(mockContext);
  });

  afterEach(() => {});

  describe('build', () => {
    it('should build basic query options', async () => {
      const options = await builder.build();

      expect(options.model).toBe('default');
      expect(options.maxTurns).toBe(Infinity);
      expect(options.cwd).toBe('/test/workspace');
    });

    it('should include maxBudgetUsd when configured', async () => {
      mockSession.config.maxBudgetUsd = 10;
      const options = await builder.build();
      expect(options.maxBudgetUsd).toBe(10);
    });

    it('should set permissionMode from session config', async () => {
      mockSession.config.permissionMode = 'acceptEdits';
      const options = await builder.build();
      expect(options.permissionMode).toBe('acceptEdits');
    });

    it('should set allowDangerouslySkipPermissions when bypassPermissions', async () => {
      mockSession.config.permissionMode = 'bypassPermissions';
      const options = await builder.build();
      expect(options.permissionMode).toBeUndefined();
      expect(builder.getDeferredPermissionMode()).toBe('bypassPermissions');
      expect(options.allowDangerouslySkipPermissions).toBe(true);
    });

    it('should include fallbackModel and opt into refusal fallback dialogs when configured', async () => {
      mockSession.config.fallbackModel = 'haiku';
      const options = await builder.build();
      expect(options.fallbackModel).toBe('haiku');
      expect(options.supportedDialogKinds).toEqual(['refusal_fallback_prompt']);
      expect(
        await options.onUserDialog?.(
          { dialogKind: 'refusal_fallback_prompt', payload: {} },
          { signal: new AbortController().signal }
        )
      ).toEqual({ behavior: 'completed', result: { continue: true } });
      expect(
        await options.onUserDialog?.(
          { dialogKind: 'unknown', payload: {} },
          { signal: new AbortController().signal }
        )
      ).toEqual({ behavior: 'cancelled' });
    });

    it('should include agents when configured', async () => {
      mockSession.config.agents = {
        'test-agent': {
          name: 'test-agent',
          description: 'Test agent',
          prompt: 'Test prompt',
        },
      };
      const options = await builder.build();
      expect(options.agents).toBeDefined();
    });

    it('does not widen a non-native worker parent tool surface for the internal child override', () => {
      const tools = ['Read', 'Bash'];
      const agents = {
        'general-purpose': {
          description:
            'Investigate a focused question using files, search, shell commands, and web sources. Complete the assigned work directly; do not delegate it to another agent.',
          tools: ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'ToolSearch'],
          disallowedTools: ['Agent', 'Task', 'TaskOutput', 'TaskStop'],
          prompt:
            'Complete the assigned investigation directly. You may use the available read, search, shell, and web tools, but you must not spawn or delegate to other agents.',
          model: 'inherit' as const,
        },
      };

      expect(ensureAgentTools(tools, agents, 'glm', 'worker')).toBe(tools);
      expect(ensureAgentTools(undefined, agents, 'glm', 'worker')).toBeUndefined();
    });

    it('still exposes a user-defined general-purpose agent on non-native workers', () => {
      const agents = {
        'general-purpose': {
          description: 'User agent',
          prompt: 'Custom behavior',
          model: 'inherit' as const,
        },
      };

      expect(ensureAgentTools(undefined, agents, 'glm', 'worker')).toEqual(
        expect.arrayContaining(['Agent', 'Task', 'TaskOutput', 'TaskStop'])
      );
    });

    it('should include sandbox settings when configured', async () => {
      mockSession.config.sandbox = { enabled: true };
      const options = await builder.build();
      expect(options.sandbox).toEqual({ enabled: true });
    });

    it('should include outputFormat when configured', async () => {
      mockSession.config.outputFormat = {
        type: 'json_schema',
        schema: { type: 'object' },
      };
      const options = await builder.build();
      expect(options.outputFormat).toBeDefined();
    });

    it('should include betas when configured', async () => {
      mockSession.config.betas = ['beta-feature'];
      const options = await builder.build();
      expect(options.betas).toEqual(['beta-feature']);
    });

    describe('includePartialMessages (delivery stall-watchdog liveness heartbeat)', () => {
      const KEY = 'HYPERNEO_MESSAGE_DELIVERY_V2';
      function withV2(value: string | undefined, fn: () => Promise<void>): Promise<void> {
        const prev = process.env[KEY];
        if (value === undefined) delete process.env[KEY];
        else process.env[KEY] = value;
        return fn().finally(() => {
          if (prev === undefined) delete process.env[KEY];
          else process.env[KEY] = prev;
        });
      }

      it('is enabled by default (delivery v2 on → stream_event heartbeats flow)', async () => {
        await withV2(undefined, async () => {
          const options = await builder.build();
          expect(options.includePartialMessages).toBe(true);
        });
      });

      it('is disabled when delivery v2 is off (no watchdog armed, no heartbeats needed)', async () => {
        await withV2('0', async () => {
          const options = await builder.build();
          expect(options.includePartialMessages).toBe(false);
        });
      });

      it('a per-session override wins over the delivery-v2 default', async () => {
        await withV2('0', async () => {
          mockSession.config.includePartialMessages = true;
          const options = await builder.build();
          expect(options.includePartialMessages).toBe(true);
        });
      });
    });

    it('should include env when configured', async () => {
      mockSession.config.env = { MY_VAR: 'value' };
      const options = await builder.build();
      expect(options.env).toMatchObject({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MY_VAR: 'value',
      });
    });

    it('should filter provider env overrides so provider cleanup owns the SDK env', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({
        env: {
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
          CLAUDE_CODE_SUBAGENT_MODEL: 'wrong-subagent',
          ENABLE_TOOL_SEARCH: 'true',
          KEEP_GLOBAL: 'global',
        },
        settingSources: ['user', 'project', 'local'],
      }));
      mockSession.config.env = {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
        CLAUDE_CODE_SUBAGENT_MODEL: 'session-subagent',
        ENABLE_TOOL_SEARCH: 'false',
        KEEP_SESSION: 'session',
      };

      const options = await builder.build();

      expect(options.env).toMatchObject({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KEEP_GLOBAL: 'global',
        KEEP_SESSION: 'session',
      });
      expect(options.env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
      expect(options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe('session-subagent');
      expect(options.env?.ENABLE_TOOL_SEARCH).toBe('false');
    });

    it('should preserve env-only Anthropic auth tokens for native provider', async () => {
      const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
      process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-env-only-token';
      try {
        const options = await builder.build();
        expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat-env-only-token');
      } finally {
        if (previousAuthToken === undefined) {
          delete process.env.ANTHROPIC_AUTH_TOKEN;
        } else {
          process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
        }
      }
    });

    it.skipIf(typeof (globalThis as { Bun?: unknown }).Bun === 'undefined')(
      'should filter provider-managed auto-compact env overrides for bridge providers',
      async () => {
        mockSettingsManager.getGlobalSettings = mock(() => ({
          env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', KEEP_GLOBAL: 'global' },
          settingSources: ['user', 'project', 'local'],
        }));
        mockSession.config.provider = 'anthropic-codex';
        mockSession.config.model = 'gpt-5.3-codex';
        mockSession.config.env = {
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
          KEEP_SESSION: 'session',
        };

        const options = await builder.build();

        expect(options.env).toMatchObject({
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          KEEP_GLOBAL: 'global',
          KEEP_SESSION: 'session',
        });
        expect(options.env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
      }
    );

    it('should not override SDK auto-compaction settings for native anthropic provider', async () => {
      const options = await builder.build();
      expect(options.settings).toEqual({ cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS });
    });

    it('should pin SDK transcript retention for every session', async () => {
      const options = await builder.build();
      expect(options.settings?.cleanupPeriodDays).toBe(SDK_TRANSCRIPT_RETENTION_DAYS);
    });

    it('withSdkTranscriptRetention merges over caller settings without dropping them', () => {
      expect(withSdkTranscriptRetention()).toEqual({
        cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS,
      });
      expect(withSdkTranscriptRetention({ autoCompactWindow: 1000 })).toEqual({
        autoCompactWindow: 1000,
        cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS,
      });
    });

    it('should remove undefined values from options', async () => {
      const options = await builder.build();
      for (const [_key, value] of Object.entries(options)) {
        expect(value).not.toBeUndefined();
      }
    });
  });

  describe('provider settings', () => {
    it('should not override SDK auto-compaction settings for native anthropic provider', () => {
      expect(buildProviderSettings('anthropic')).toBeUndefined();
    });

    it('should not override SDK auto-compaction for anthropic-codex (handled natively)', () => {
      expect(buildProviderSettings('anthropic-codex')).toBeUndefined();
      expect(buildProviderSettings('anthropic-codex', 272_000)).toBeUndefined();
    });

    it('should not override SDK auto-compaction for GLM (env var + [1m] suffix configures SDK correctly)', () => {
      expect(buildProviderSettings('glm')).toBeUndefined();
      expect(buildProviderSettings('glm', 1_000_000)).toBeUndefined();
    });

    it('should enable SDK auto-compaction for non-native providers with context windows', () => {
      expect(buildProviderSettings('openrouter', 1_000_000)).toEqual({
        autoCompactEnabled: true,
        autoCompactWindow: 1_000_000,
      });
      expect(buildProviderSettings('ollama', 32_000)).toEqual({
        autoCompactEnabled: true,
        autoCompactWindow: 32_000,
      });
    });

    it('should not disable SDK auto-compaction when context window is unavailable (avoid dead zone)', () => {
      expect(buildProviderSettings('openrouter')).toBeUndefined();
    });

    it('should keep SDK native auto-compact ON for Kimi (do not disable to chase 262k)', () => {
      expect(buildProviderSettings('kimi')).toBeUndefined();
      expect(buildProviderSettings('kimi', 262_144)).toEqual({
        autoCompactEnabled: true,
        autoCompactWindow: 262_144,
      });
    });

    it('should explicitly pass the 1M window for Kimi K3', () => {
      expect(buildProviderSettings('kimi', 1_048_576, 'kimi-k3')).toEqual({
        autoCompactEnabled: true,
        autoCompactWindow: 1_048_576,
      });
      expect(buildProviderSettings('kimi', 1_048_576, 'moonshot-k3-preview')).toEqual({
        autoCompactEnabled: true,
        autoCompactWindow: 1_048_576,
      });
    });

    it('should pass the 256K window for the k3-256k K3 variant', () => {
      expect(buildProviderSettings('kimi', 262_144, 'k3-256k')).toEqual({
        autoCompactEnabled: true,
        autoCompactWindow: 262_144,
      });
      expect(buildProviderSettings('kimi', 262_144, 'kimi-k3-256k')).toEqual({
        autoCompactEnabled: true,
        autoCompactWindow: 262_144,
      });
    });

    it('should still return undefined for anthropic-copilot (native Anthropic API)', () => {
      expect(buildProviderSettings('anthropic-copilot')).toBeUndefined();
    });
  });

  describe('auto-compact settings via build()', () => {
    function registerOpenRouterProvider(): void {
      resetProviderRegistry();
      const registry = getProviderRegistry();
      registry.register({
        id: 'openrouter',
        displayName: 'OpenRouter',
        capabilities: {
          streaming: true,
          extendedThinking: false,
          maxContextWindow: 1_000_000,
          functionCalling: true,
          vision: true,
        },
        isAvailable: () => true,
        getModels: async () => [],
        ownsModel: () => false,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);
    }

    afterEach(() => {
      setModelsCache(new Map());
      resetProviderRegistry();
    });

    it('should enable SDK auto-compaction for OpenRouter models with their context window', async () => {
      registerOpenRouterProvider();
      setModelsCache(
        new Map([
          [
            'global',
            [
              {
                id: 'deepseek-v4',
                name: 'DeepSeek V4',
                provider: 'openrouter',
                contextWindow: 1_000_000,
                available: true,
              },
            ],
          ],
        ])
      );
      mockSession.config.provider = 'openrouter';
      mockSession.config.model = 'deepseek-v4';
      const options = await builder.build();
      expect(options.settings).toEqual({
        autoCompactEnabled: true,
        autoCompactWindow: 1_000_000,
        cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS,
      });
    });

    it('should not disable SDK auto-compaction for OpenRouter when model is unknown (avoid dead zone)', async () => {
      registerOpenRouterProvider();
      setModelsCache(new Map());
      mockSession.config.provider = 'openrouter';
      mockSession.config.model = 'unknown-model';
      const options = await builder.build();
      expect(options.settings).toEqual({ cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS });
    });

    it('should leave provider settings empty for native anthropic provider', async () => {
      const options = await builder.build();
      expect(options.settings).toEqual({ cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS });
    });
  });

  describe('subagent model env guard (CLAUDE_CODE_SUBAGENT_MODEL)', () => {
    const foreignSubagentModel = 'k3-256k';
    let savedSubagentModel: string | undefined;
    let savedToolSearch: string | undefined;

    function registerCompatProvider(envVars: Record<string, string>): void {
      resetProviderRegistry();
      const registry = getProviderRegistry();
      registry.register({
        id: 'glm',
        displayName: 'Z.ai',
        capabilities: {
          streaming: true,
          extendedThinking: true,
          maxContextWindow: 1_000_000,
          functionCalling: true,
          vision: true,
        },
        isAvailable: () => true,
        getModels: async () => [],
        ownsModel: (modelId: string) => modelId.startsWith('glm-'),
        buildSdkConfig: () => ({ envVars, isAnthropicCompatible: true }),
      } as Provider);
    }

    beforeEach(() => {
      savedSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      savedToolSearch = process.env.ENABLE_TOOL_SEARCH;
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = foreignSubagentModel;
      process.env.ENABLE_TOOL_SEARCH = 'true';
    });

    afterEach(() => {
      if (savedSubagentModel === undefined) {
        delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      } else {
        process.env.CLAUDE_CODE_SUBAGENT_MODEL = savedSubagentModel;
      }
      if (savedToolSearch === undefined) {
        delete process.env.ENABLE_TOOL_SEARCH;
      } else {
        process.env.ENABLE_TOOL_SEARCH = savedToolSearch;
      }
      resetProviderRegistry();
    });

    it('forwards the provider-defined subagent model over an ambient leftover', async () => {
      registerCompatProvider({
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.3',
        ENABLE_TOOL_SEARCH: 'false',
      });
      mockSession.config.provider = 'glm';
      mockSession.config.model = 'glm-5.3';

      const options = await builder.build();

      expect(options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe('glm-5.3');
      expect(options.env?.ENABLE_TOOL_SEARCH).toBe('false');
    });

    it('omits the subagent model when the provider does not define one, even with an ambient leftover', async () => {
      registerCompatProvider({
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      });
      mockSession.config.provider = 'glm';
      mockSession.config.model = 'glm-5.3';

      const options = await builder.build();

      expect(options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
      expect(options.env?.ENABLE_TOOL_SEARCH).toBeUndefined();
    });
  });

  describe('getCwd', () => {
    it('should return workspacePath when no worktree', () => {
      expect(builder.getCwd()).toBe('/test/workspace');
    });

    it('should return worktreePath when worktree exists', () => {
      mockSession.worktree = {
        worktreePath: '/worktree/path',
        mainRepoPath: '/main/repo',
        branch: 'session/test',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      expect(newBuilder.getCwd()).toBe('/worktree/path');
    });
  });

  describe('setCanUseTool', () => {
    it('should set canUseTool callback', async () => {
      const callback = mock(async () => ({ behavior: 'allow' as const }));
      builder.setCanUseTool(callback);

      const options = await builder.build();
      expect(options.canUseTool).toBe(callback);
    });
  });

  describe('addSessionStateOptions', () => {
    it('should add resume parameter when SDK session ID exists', async () => {
      mockSession.sdkSessionId = 'sdk-session-123';
      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.resume).toBe('sdk-session-123');
    });

    it('should add pending one-shot resumeSessionAt via peek (not consume)', async () => {
      mockSession.sdkSessionId = 'sdk-session-valid';
      const peekPendingResumeSessionAt = mock(() => 'resumable-message-uuid');
      builder = new QueryOptionsBuilder({
        ...mockContext,
        peekPendingResumeSessionAt,
      });

      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.resume).toBe('sdk-session-valid');
      expect(result.resumeSessionAt).toBe('resumable-message-uuid');
      expect(peekPendingResumeSessionAt).toHaveBeenCalledTimes(1);
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('should not read persisted metadata resumeSessionAt', async () => {
      mockSession.sdkSessionId = 'sdk-session-valid';
      (mockSession.metadata as Record<string, unknown>).resumeSessionAt = 'stale-persisted-uuid';

      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.resume).toBe('sdk-session-valid');
      expect(result.resumeSessionAt).toBeUndefined();
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('should not carry compact summaries while building resume options', async () => {
      mockSession.sdkSessionId = 'sdk-session-valid';
      mockSession.sdkOriginPath = mockSession.workspacePath;
      const peekPendingResumeSessionAt = mock(() => undefined);
      builder = new QueryOptionsBuilder({
        ...mockContext,
        peekPendingResumeSessionAt,
      });

      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.resume).toBe('sdk-session-valid');
      expect(result.resumeSessionAt).toBeUndefined();
      expect(updateSessionSpy).not.toHaveBeenCalled();
    });

    it('should not add resume when no SDK session ID', async () => {
      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.resume).toBeUndefined();
    });

    it('should add resume for room sessions when SDK session ID exists', async () => {
      mockSession.type = 'room';
      mockSession.sdkSessionId = 'sdk-session-123';
      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.resume).toBe('sdk-session-123');
    });

    it('should add resume for manager/worker orchestration sessions', async () => {
      mockSession.sdkSessionId = 'sdk-session-123';
      mockSession.metadata.sessionType = 'manager';
      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.resume).toBe('sdk-session-123');
    });

    it('should add thinking tokens based on thinkingLevel', async () => {
      mockSession.config.thinkingLevel = 'think24k';
      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 24000 });
    });

    it('should use global thinking level when session has no override', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({ thinkingLevel: 'think16k' })) as never;
      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
    });

    it('should explicitly disable thinking for thinking-capable providers when level is off', async () => {
      const options = await builder.build();
      const result = builder.addSessionStateOptions(options);

      expect(result.thinking).toEqual({ type: 'disabled' });
    });

    it('should omit thinking config for providers with thinkingModes=off', async () => {
      mockSession.config.provider = 'minimax';
      mockSession.config.thinkingLevel = 'think32k';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toBeUndefined();
    });

    it('should preserve selected budget for providers with thinkingModes=on', async () => {
      mockSession.config.provider = 'anthropic';
      mockSession.config.thinkingLevel = 'think8k';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    });

    it('omits thinking config for kimi K3 when level is off', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'kimi-k3';
      mockSession.config.thinkingLevel = 'off';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toBeUndefined();
    });

    it('forces thinking enabled for kimi-k2.7-code-highspeed when level is off', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'kimi-k2.7-code-highspeed';
      mockSession.config.thinkingLevel = 'off';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
    });

    it('forces thinking enabled for regular kimi K2.7 models when level is off', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'kimi-for-coding';
      mockSession.config.thinkingLevel = 'off';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
    });

    it('preserves thinking-off for discovered moonshot models that are not K2.7 aliases', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'moonshot-v1-32k';
      mockSession.config.thinkingLevel = 'off';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'disabled' });
    });

    it('emits a granular thinking budget for kimi K3 when a level is selected', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'kimi-k3';
      mockSession.config.thinkingLevel = 'think8k';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    });

    it('emits a granular thinking budget for k3-256k when a level is selected', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'k3-256k';
      mockSession.config.thinkingLevel = 'think32k';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 31999 });
    });

    it('emits a granular thinking budget for moonshot-k3 prefix aliases when a level is selected', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'moonshot-k3-preview';
      mockSession.config.thinkingLevel = 'think8k';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    });

    it('should omit thinking config for providers with thinkingModes=off even when level is off', async () => {
      mockSession.config.provider = 'minimax';
      mockSession.config.thinkingLevel = 'off';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toBeUndefined();
    });

    it('honours per-model thinking mode override even when provider aggregate advertises thinking', async () => {
      const registry = getProviderRegistry();
      registry.register({
        id: 'custom:per-model-thinking',
        displayName: 'Per-model thinking',
        capabilities: {
          streaming: true,
          extendedThinking: true,
          thinkingModes: 'on',
          maxContextWindow: 32000,
          functionCalling: true,
          vision: false,
        },
        isAvailable: () => true,
        getModels: async () => [],
        ownsModel: () => true,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
        getModelThinkingMode: (modelId: string) => (modelId === 'reasoner' ? 'on' : 'off'),
      } as Provider);
      try {
        mockSession.config.provider = 'custom:per-model-thinking';
        mockSession.config.model = 'plain';
        mockSession.config.thinkingLevel = 'think8k';
        const result = builder.addSessionStateOptions(
          {} as import('@anthropic-ai/claude-agent-sdk').Options
        );
        expect(result.thinking).toBeUndefined();
      } finally {
        resetProviderRegistry();
      }
    });

    it('emits thinking config when per-model mode is on and provider aggregate would otherwise allow it', async () => {
      const registry = getProviderRegistry();
      registry.register({
        id: 'custom:per-model-thinking-2',
        displayName: 'Per-model thinking 2',
        capabilities: {
          streaming: true,
          extendedThinking: true,
          thinkingModes: 'on',
          maxContextWindow: 32000,
          functionCalling: true,
          vision: false,
        },
        isAvailable: () => true,
        getModels: async () => [],
        ownsModel: () => true,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
        getModelThinkingMode: (modelId: string) => (modelId === 'reasoner' ? 'on' : 'off'),
      } as Provider);
      try {
        mockSession.config.provider = 'custom:per-model-thinking-2';
        mockSession.config.model = 'reasoner';
        mockSession.config.thinkingLevel = 'think8k';
        const result = builder.addSessionStateOptions(
          {} as import('@anthropic-ai/claude-agent-sdk').Options
        );
        expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
      } finally {
        resetProviderRegistry();
      }
    });

    it('forces an enabled budget for mixed Kimi K3 primary and K2.7 fallback chains', () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'kimi-k3';
      mockSession.config.fallbackModel = 'kimi-k2.7-code';
      mockSession.config.thinkingLevel = 'off';

      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );
      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
    });

    it('allows mixed Kimi K2.7 primary and K3 fallback when K2.7 forces enabled thinking', () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'kimi-for-coding';
      mockSession.config.fallbackModel = 'k3';
      mockSession.config.thinkingLevel = 'off';

      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );
      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
    });

    it('allows Kimi K3 primary and K3 fallback with granular thinking', () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'kimi-k3';
      mockSession.config.fallbackModel = 'k3';
      mockSession.config.thinkingLevel = 'think8k';

      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );
      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    });

    it('allows Kimi K2.7 primary and K2.7 fallback with enabled thinking', () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.model = 'kimi-for-coding';
      mockSession.config.fallbackModel = 'kimi-k2.7-code-highspeed';
      mockSession.config.thinkingLevel = 'off';

      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );
      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 16000 });
    });
  });

  describe('system prompt configuration', () => {
    it('should use Claude Code preset by default', async () => {
      const options = await builder.build();

      expect(options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
      });
    });

    it('should append worktree isolation text when worktree exists', async () => {
      mockSession.worktree = {
        worktreePath: '/worktree/path',
        mainRepoPath: '/main/repo',
        branch: 'session/test-branch',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      expect(options.systemPrompt).toEqual(
        expect.objectContaining({
          type: 'preset',
          preset: 'claude_code',
          append: expect.stringContaining('Git Worktree Isolation'),
        })
      );
    });

    it('should use custom string system prompt when set', async () => {
      mockSession.config.systemPrompt = 'Custom system prompt';
      const options = await builder.build();

      expect(options.systemPrompt).toBe('Custom system prompt');
    });

    it('should combine custom prompt with worktree isolation', async () => {
      mockSession.config.systemPrompt = 'Custom prompt';
      mockSession.worktree = {
        worktreePath: '/worktree',
        mainRepoPath: '/main',
        branch: 'session/test',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      expect(options.systemPrompt).toContain('Custom prompt');
      expect(options.systemPrompt).toContain('Git Worktree Isolation');
    });

    it('should use minimal worktree prompt when Claude Code preset disabled', async () => {
      mockSession.config.tools = { useClaudeCodePreset: false };
      mockSession.worktree = {
        worktreePath: '/worktree',
        mainRepoPath: '/main',
        branch: 'session/test',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      expect(typeof options.systemPrompt).toBe('string');
      expect(options.systemPrompt).toContain('Git Worktree Isolation');
    });
  });

  describe('tools configuration', () => {
    it('should include sdkToolsPreset when configured', async () => {
      mockSession.config.sdkToolsPreset = 'full';
      const options = await builder.build();
      expect(options.tools).toBe('full');
    });

    it('should include allowedTools when configured', async () => {
      mockSession.config.permissionMode = 'acceptEdits';
      mockSession.config.allowedTools = ['Bash', 'Read'];
      const options = await builder.build();
      expect(options.allowedTools).toEqual(['Bash', 'Read']);
    });

    it('should include disallowedTools when configured', async () => {
      mockSession.config.disallowedTools = ['Write'];
      const options = await builder.build();
      expect(options.disallowedTools).toContain('Write');
    });
  });

  describe('MCP servers configuration', () => {
    it('should use configured mcpServers', async () => {
      mockSession.config.mcpServers = {
        'test-server': { command: 'test-command' },
      };
      const options = await builder.build();

      expect(options.mcpServers).toEqual({
        'test-server': { command: 'test-command' },
      });
    });

    it('leaves mcpServers undefined when none are configured', async () => {
      const options = await builder.build();
      expect(options.mcpServers).toBeUndefined();
    });
  });

  describe('setting sources configuration', () => {
    it('should default settingSources to global settings', async () => {
      const options = await builder.build();
      expect(options.settingSources).toEqual(['user', 'project', 'local']);
    });
  });

  describe('space chat session restrictions', () => {
    it('should preserve space MCP servers while enforcing strict MCP config', async () => {
      mockSession.type = 'space_chat';
      mockSession.config.mcpServers = {
        'space-agent-tools': { command: 'space-cmd' },
      };

      const options = await builder.build();
      expect(options.mcpServers).toEqual({
        'space-agent-tools': { command: 'space-cmd' },
      });
      expect(options.strictMcpConfig).toBe(true);
      expect(options.settingSources).toEqual(['user', 'project', 'local']);
    });

    it('should enforce space built-in tool allowlist including Bash and subagents', async () => {
      mockSession.type = 'space_chat';
      mockSession.config.permissionMode = 'acceptEdits';
      const options = await builder.build();
      expect(options.tools).toEqual([
        'Read',
        'Glob',
        'Grep',
        'Bash',
        'WebFetch',
        'WebSearch',
        'ToolSearch',
        'AskUserQuestion',
        'Agent',
        'Task',
        'TaskOutput',
        'TaskStop',
      ]);
      expect(options.allowedTools).toEqual(
        expect.arrayContaining([
          'Read',
          'Glob',
          'Grep',
          'Bash',
          'WebFetch',
          'WebSearch',
          'ToolSearch',
          'AskUserQuestion',
          'Agent',
          'Task',
          'TaskOutput',
          'TaskStop',
        ])
      );
    });

    it('should keep file editing tools disallowed while allowing subagents', async () => {
      mockSession.type = 'space_chat';
      const options = await builder.build();

      expect(options.disallowedTools).toEqual(
        expect.arrayContaining(['Edit', 'Write', 'NotebookEdit'])
      );
      expect(options.disallowedTools).not.toContain('Task');
      expect(options.disallowedTools).not.toContain('TaskOutput');
      expect(options.disallowedTools).not.toContain('TaskStop');
    });

    it('honors a coordinator sdkToolsPreset instead of clobbering it (Task #794)', async () => {
      mockSession.type = 'space_chat';
      mockSession.config.permissionMode = 'acceptEdits';
      mockSession.config.sdkToolsPreset = [...LONG_HORIZON_AGENT_BUILTIN_TOOLS];
      const options = await builder.build();

      expect(options.tools).toEqual([...LONG_HORIZON_AGENT_BUILTIN_TOOLS]);
      expect(options.tools).not.toContain('Write');
      expect(options.tools).not.toContain('Edit');
      expect(options.tools).not.toContain('MultiEdit');
      expect(options.tools).toContain('CronCreate');
      expect(options.tools).toContain('Monitor');
      expect(options.allowedTools).toEqual(
        expect.arrayContaining([...LONG_HORIZON_AGENT_BUILTIN_TOOLS])
      );
      expect(options.disallowedTools).toEqual(
        expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
      );
    });

    it('should not include Write/Edit/NotebookEdit in space chat tool allowlist', async () => {
      mockSession.type = 'space_chat';
      const options = await builder.build();
      expect(options.disallowedTools).toEqual(
        expect.arrayContaining(['Edit', 'Write', 'NotebookEdit'])
      );
      expect(options.tools).not.toContain('Edit');
      expect(options.tools).not.toContain('Write');
      expect(options.tools).not.toContain('NotebookEdit');
    });

    it('should auto-allow wildcards for all configured space MCP servers', async () => {
      mockSession.type = 'space_chat';
      mockSession.config.permissionMode = 'acceptEdits';
      mockSession.config.mcpServers = {
        'space-agent-tools': { command: 'space-cmd' },
        'db-query': { command: 'db-cmd' },
      };

      const options = await builder.build();
      expect(options.allowedTools).toEqual(
        expect.arrayContaining(['space-agent-tools__*', 'db-query__*'])
      );
    });

    it('should disable Claude Code preset system prompt for space chat sessions', async () => {
      mockSession.type = 'space_chat';
      const options = await builder.build();
      expect(options.systemPrompt).toBeUndefined();
    });

    it('should preserve a custom string system prompt for space chat sessions', async () => {
      mockSession.type = 'space_chat';
      mockSession.config.systemPrompt = 'You are the Space coordinator.';
      const options = await builder.build();
      expect(options.systemPrompt).toBe('You are the Space coordinator.');
    });

    it('should not affect worker sessions tool allowlist (coder/reviewer tool access unchanged)', async () => {
      mockSession.type = 'worker';
      const options = await builder.build();
      expect(options.strictMcpConfig).toBe(true);
      expect(options.tools).toBeUndefined();
    });
  });

  describe('M5: unconditional strict MCP + configurable settingSources', () => {
    const sessionTypes: Array<'worker' | 'space_task_agent' | 'general' | 'coder' | 'planner'> = [
      'worker',
      'space_task_agent',
      'general',
      'coder',
      'planner',
    ];

    for (const type of sessionTypes) {
      it(`forces strictMcpConfig=true and default settingSources on ${type} sessions`, async () => {
        mockSession.type = type;
        const options = await builder.build();
        expect(options.strictMcpConfig).toBe(true);
        expect(options.settingSources).toEqual(['user', 'project', 'local']);
      });
    }

    it('does not inject project .mcp.json servers into the mcpServers map (regression)', async () => {
      mockSession.type = 'worker';
      mockSession.config.mcpServers = undefined;
      const options = await builder.build();
      expect(options.mcpServers).toBeUndefined();
      expect(options.strictMcpConfig).toBe(true);
      expect(options.settingSources).toEqual(['user', 'project', 'local']);
    });

    it('preserves explicit mcpServers from session config under strict mode', async () => {
      mockSession.type = 'space_task_agent';
      mockSession.config.mcpServers = {
        'task-agent': { command: 'task-cmd' },
      };
      const options = await builder.build();
      expect(options.strictMcpConfig).toBe(true);
      expect(options.settingSources).toEqual(['user', 'project', 'local']);
      expect(options.mcpServers).toEqual({ 'task-agent': { command: 'task-cmd' } });
    });

    it('ignores HYPERNEO_LEGACY_MCP_AUTOLOAD — the M1 kill switch was removed in M5', async () => {
      const previous = process.env.HYPERNEO_LEGACY_MCP_AUTOLOAD;
      try {
        for (const val of ['1', 'true', 'yes']) {
          process.env.HYPERNEO_LEGACY_MCP_AUTOLOAD = val;
          mockSession.type = 'worker';
          const options = await builder.build();
          expect(options.strictMcpConfig).toBe(true);
          expect(options.settingSources).toEqual(['user', 'project', 'local']);
        }
      } finally {
        if (previous === undefined) {
          delete process.env.HYPERNEO_LEGACY_MCP_AUTOLOAD;
        } else {
          process.env.HYPERNEO_LEGACY_MCP_AUTOLOAD = previous;
        }
      }
    });
  });

  describe('additional directories configuration', () => {
    it('should allow temp directories for shell operations when worktree exists', async () => {
      mockSession.worktree = {
        worktreePath: '/worktree',
        mainRepoPath: '/main',
        branch: 'session/test',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      const expected = [homedir() + '/.claude', homedir() + '/.hyperneo'];
      expected.push('/tmp', '/tmp/claude', expect.stringContaining('/tmp/zsh-'));
      expect(options.additionalDirectories).toEqual(expected);
    });

    it('should include home directories when no worktree', async () => {
      const options = await builder.build();
      const expected = [homedir() + '/.claude', homedir() + '/.hyperneo'];
      expect(options.additionalDirectories).toEqual(expected);
    });
  });

  describe('permission mode', () => {
    it('should use session config permission mode first', async () => {
      mockSession.config.permissionMode = 'acceptEdits';
      const options = await builder.build();
      expect(options.permissionMode).toBe('acceptEdits');
    });

    it('should fallback to global settings', async () => {
      (mockSettingsManager.getGlobalSettings as ReturnType<typeof mock>).mockReturnValue({
        permissionMode: 'prompt',
      });
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      expect(options.permissionMode).toBe('prompt');
    });

    it('should default to bypassPermissions (withheld at intake, deferred)', async () => {
      const options = await builder.build();
      expect(options.permissionMode).toBeUndefined();
      expect(builder.getDeferredPermissionMode()).toBe('bypassPermissions');
    });

    it('should map default to bypassPermissions (withheld at intake, deferred)', async () => {
      mockSession.config.permissionMode = 'default';
      const options = await builder.build();
      expect(options.permissionMode).toBeUndefined();
      expect(builder.getDeferredPermissionMode()).toBe('bypassPermissions');
    });
  });

  describe('hooks configuration', () => {
    const NO_MERGE_GUARD = {
      matcher: 'Bash',
      pattern:
        '(?:^|[;&|()\\n`])\\s*(?:(?:env\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|()`]+|command)\\s+)*gh[\\s\\\\]+pr[\\s\\\\]+merge\\b',
      decision: 'deny' as const,
      reason:
        'Coder-role agents must not merge PRs. Their job is implementation only; the reviewer handles the merge after approval.',
    };

    it('should always install the loop-detector hook even with no toolGuards', async () => {
      const options = await builder.build();

      expect(options.hooks?.PreToolUse).toBeDefined();
      expect(options.hooks?.PreToolUse).toHaveLength(1);
      expect(options.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
      expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    });

    it('registers the AskUserQuestion PreToolUse hook first when set (bypassPermissions interception channel)', async () => {
      const auqHook = (async () => ({})) as unknown as Parameters<
        QueryOptionsBuilder['setAskUserQuestionHook']
      >[0];
      builder.setAskUserQuestionHook(auqHook);
      const options = await builder.build();

      expect(options.hooks?.PreToolUse?.[0]?.matcher).toBe('AskUserQuestion');
      expect(options.hooks?.PreToolUse?.[0]?.hooks[0]).toBe(auqHook);
      expect(options.hooks?.PreToolUse?.[1]?.matcher).toBeUndefined();
    });

    it('installs a Bash-matcher scope hook from scoped Bash allowedTools entries', async () => {
      mockSession.config.allowedTools = ['Task', 'Bash(gh pr view:*)', 'Bash(jq:*)'];
      const options = await builder.build();

      const bashEntry = options.hooks?.PreToolUse?.find((entry) => entry.matcher === 'Bash');
      expect(bashEntry).toBeDefined();
      expect(bashEntry?.hooks).toHaveLength(1);
      const scopeHook = bashEntry?.hooks[0];
      const denied = (await scopeHook?.({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'bun test' },
      } as never)) as { hookSpecificOutput: { permissionDecision: string } };
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
      const allowed = await scopeHook?.({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr view 123 --json id' },
      } as never);
      expect(allowed).toEqual({});
    });

    it('adds no Bash scope hook when allowedTools has no scoped Bash entries', async () => {
      mockSession.config.allowedTools = ['Task', 'TaskOutput'];
      const options = await builder.build();

      expect(options.hooks?.PreToolUse?.find((entry) => entry.matcher === 'Bash')).toBeUndefined();
    });

    it('getCurrentPermissionMode re-resolves the live mode for the deferred-switch staleness guard', async () => {
      mockSession.config.permissionMode = 'bypassPermissions';
      await builder.build();
      expect(builder.getCurrentPermissionMode()).toBe('bypassPermissions');

      mockSession.config.permissionMode = 'acceptEdits';
      expect(builder.getCurrentPermissionMode()).toBe('acceptEdits');
    });

    it('should install the output-limiter hook when enabled in global settings', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({
        settingSources: ['user', 'project', 'local'],
        sandbox: { excludedCommands: ['git'] },
        outputLimiter: {
          enabled: true,
          bash: { headLines: 100, tailLines: 200 },
          read: { maxLines: 1000 },
          grep: { maxMatches: 500 },
          excludeTools: [],
        },
      }));

      const options = await new QueryOptionsBuilder(mockContext).build();

      expect(options.hooks?.PreToolUse).toHaveLength(2);
      expect(options.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
      expect(options.hooks?.PreToolUse?.[1]?.matcher).toBeUndefined();
      expect(options.hooks?.PreToolUse?.[1]?.hooks).toHaveLength(1);
    });

    it('should default a partial outputLimiter setting to enabled', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({
        settingSources: ['user', 'project', 'local'],
        sandbox: { excludedCommands: ['git'] },
        outputLimiter: {
          bash: { headLines: 50 },
        },
      }));

      const options = await new QueryOptionsBuilder(mockContext).build();

      expect(options.hooks?.PreToolUse).toHaveLength(2);
    });

    it('should not install the output-limiter hook when disabled in global settings', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({
        settingSources: ['user', 'project', 'local'],
        outputLimiter: { enabled: false },
      }));

      const options = await new QueryOptionsBuilder(mockContext).build();

      expect(options.hooks?.PreToolUse).toHaveLength(1);
      expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    });

    it('should truncate large Bash output via PostToolUse updatedToolOutput', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({
        settingSources: ['user', 'project', 'local'],
        outputLimiter: {
          enabled: true,
          bash: { headLines: 5, tailLines: 5 },
          read: { maxLines: 1000 },
          grep: { maxMatches: 250 },
          excludeTools: [],
        },
      }));

      const options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.hooks?.PostToolUse).toHaveLength(2);
      const postHook = options.hooks?.PostToolUse?.[1]?.hooks[0];
      expect(postHook).toBeDefined();

      const largeOutput = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const result = await postHook!(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'bun test' },
          tool_response: { stdout: largeOutput, stderr: '', interrupted: false },
          tool_use_id: 'tool-1',
          session_id: 'session-1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
        },
        'tool-1',
        { signal: new AbortController().signal }
      );

      const output = (
        result as {
          hookSpecificOutput: { updatedToolOutput: { stdout: string } };
        }
      ).hookSpecificOutput.updatedToolOutput;
      expect(output.stdout).toContain('line 0');
      expect(output.stdout).toContain('line 99');
      expect(output.stdout).toContain('Truncated');
      expect(output.stdout).not.toContain('line 50');
    });

    it('should apply Read and Grep limits via the PreToolUse hook', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({
        settingSources: ['user', 'project', 'local'],
        outputLimiter: {
          enabled: true,
          bash: { headLines: 100, tailLines: 200 },
          read: { maxLines: 500 },
          grep: { maxMatches: 250 },
          excludeTools: [],
        },
      }));

      const options = await new QueryOptionsBuilder(mockContext).build();
      const preHook = options.hooks?.PreToolUse?.[1]?.hooks[0];
      expect(preHook).toBeDefined();

      const readResult = await preHook!(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: '/tmp/large-file.ts' },
          tool_use_id: 'tool-1',
          session_id: 'session-1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
        },
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(readResult).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { file_path: '/tmp/large-file.ts', limit: 500 },
        },
      });

      const grepResult = await preHook!(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'TODO', path: '/tmp/repo' },
          tool_use_id: 'tool-2',
          session_id: 'session-1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
        },
        'tool-2',
        { signal: new AbortController().signal }
      );

      expect(grepResult).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { pattern: 'TODO', path: '/tmp/repo', head_limit: 250 },
        },
      });
    });

    it('should run workflow tool guards alongside the output limiter', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({
        settingSources: ['user', 'project', 'local'],
        outputLimiter: {
          enabled: true,
          bash: { headLines: 100, tailLines: 200 },
          read: { maxLines: 1000 },
          grep: { maxMatches: 250 },
          excludeTools: [],
        },
      }));

      const anchoredGuard = {
        matcher: 'Bash',
        pattern: '^rm\\s+-rf\\s+/',
        decision: 'deny' as const,
        reason: 'No recursive force deletes from root',
      };
      const guardBuilder = new QueryOptionsBuilder({
        ...mockContext,
        toolGuards: [anchoredGuard],
      });
      const options = await guardBuilder.build();

      expect(options.hooks?.PreToolUse).toHaveLength(3);
      const guardEntry = options.hooks?.PreToolUse?.find((e) => e.matcher === 'Bash');
      expect(guardEntry).toBeDefined();

      const guardHook = guardEntry!.hooks[0];
      const guardResult = await guardHook!(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
          tool_use_id: 'tool-1',
          session_id: 'session-1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
        },
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(guardResult).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: anchoredGuard.reason,
        },
      });
    });

    it('installs paired PostToolUse and PostToolUseFailure observers for the Bash dead-loop detector', async () => {
      const options = await builder.build();

      expect(options.hooks?.PostToolUse).toBeDefined();
      expect(options.hooks?.PostToolUse).toHaveLength(1);
      expect(options.hooks?.PostToolUse?.[0]?.matcher).toBeUndefined();
      expect(options.hooks?.PostToolUse?.[0]?.hooks).toHaveLength(1);

      expect(options.hooks?.PostToolUseFailure).toBeDefined();
      expect(options.hooks?.PostToolUseFailure).toHaveLength(1);
      expect(options.hooks?.PostToolUseFailure?.[0]?.matcher).toBeUndefined();
      expect(options.hooks?.PostToolUseFailure?.[0]?.hooks).toHaveLength(1);
    });

    it('compiles declarative tool guards into PreToolUse hooks', async () => {
      const guardBuilder = new QueryOptionsBuilder({
        ...mockContext,
        toolGuards: [NO_MERGE_GUARD],
      });
      const options = await guardBuilder.build();

      const bashEntry = options.hooks?.PreToolUse?.find((e) => e.matcher === 'Bash');
      const hook = bashEntry?.hooks[0];
      expect(hook).toBeDefined();

      for (const command of [
        'gh pr merge https://github.com/org/repo/pull/1 --squash',
        '  gh pr merge https://github.com/org/repo/pull/1 --squash',
        '`gh pr merge 123`',
        'GH_TOKEN=token gh pr merge 123',
        'command gh pr merge 123',
        'env GH_TOKEN=token gh pr merge 123',
        'gh pr \\\nmerge 123',
      ]) {
        const result = await hook!(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command },
            tool_use_id: 'tool-1',
            session_id: 'session-1',
            transcript_path: '/tmp/transcript.jsonl',
            cwd: '/tmp/repo',
          },
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: NO_MERGE_GUARD.reason,
          },
        });
      }
    });

    it('allows non-merge bash commands when tool guard is present', async () => {
      const guardBuilder = new QueryOptionsBuilder({
        ...mockContext,
        toolGuards: [NO_MERGE_GUARD],
      });
      const options = await guardBuilder.build();
      const bashEntry = options.hooks?.PreToolUse?.find((e) => e.matcher === 'Bash');
      const hook = bashEntry?.hooks[0];

      const result = await hook!(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'gh pr view --json url && bun test' },
          tool_use_id: 'tool-1',
          session_id: 'session-1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
        },
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({});
    });

    it('groups guards by matcher into separate matcher entries', async () => {
      const guardBuilder = new QueryOptionsBuilder({
        ...mockContext,
        toolGuards: [
          NO_MERGE_GUARD,
          {
            matcher: 'Bash',
            pattern: 'rm\\s+-rf\\s+/',
            decision: 'deny' as const,
            reason: 'No recursive force deletes from root',
          },
        ],
      });
      const options = await guardBuilder.build();

      const bashEntries = options.hooks?.PreToolUse?.filter((e) => e.matcher === 'Bash');
      expect(bashEntries).toHaveLength(1);
      expect(bashEntries?.[0]?.hooks).toHaveLength(2);
    });

    it('gracefully skips guards with invalid regex patterns', async () => {
      const guardBuilder = new QueryOptionsBuilder({
        ...mockContext,
        toolGuards: [
          {
            matcher: 'Bash',
            pattern: '[invalid(',
            decision: 'deny' as const,
            reason: 'Bad pattern',
          },
        ],
      });
      const options = await guardBuilder.build();

      const bashEntry = options.hooks?.PreToolUse?.find((e) => e.matcher === 'Bash');
      const hook = bashEntry?.hooks[0];
      expect(hook).toBeDefined();
      const result = await hook!(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'anything' },
          tool_use_id: 'tool-1',
          session_id: 'session-1',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: '/tmp/repo',
        },
        'tool-1',
        { signal: new AbortController().signal }
      );
      expect(result).toEqual({});
    });
  });

  describe('worktree isolation text', () => {
    it('should include worktree path in isolation text', async () => {
      mockSession.worktree = {
        worktreePath: '/custom/worktree/path',
        mainRepoPath: '/main/repo',
        branch: 'session/feature',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      const systemPrompt = options.systemPrompt as { append?: string };
      expect(systemPrompt.append).toContain('/custom/worktree/path');
    });

    it('should include branch name in isolation text', async () => {
      mockSession.worktree = {
        worktreePath: '/worktree',
        mainRepoPath: '/main',
        branch: 'session/my-feature',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      const systemPrompt = options.systemPrompt as { append?: string };
      expect(systemPrompt.append).toContain('session/my-feature');
    });

    it('should include main repo path but omit merge command examples', async () => {
      mockSession.worktree = {
        worktreePath: '/worktree',
        mainRepoPath: '/projects/my-repo',
        branch: 'session/test',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      const systemPrompt = options.systemPrompt as { append?: string };
      expect(systemPrompt.append).toContain('/projects/my-repo');
      expect(systemPrompt.append).not.toContain('git --git-dir=');
      expect(systemPrompt.append).not.toContain('push origin main');
    });
  });

  describe('coordinator mode', () => {
    it('should set agent=Coordinator and include specialist agents when coordinatorMode is true', async () => {
      mockSession.config.coordinatorMode = true;
      const options = await builder.build();

      expect(options.agent).toBe('Coordinator');
      expect(options.agents).toBeDefined();
      const agentNames = Object.keys(options.agents!);
      expect(agentNames).toContain('Coordinator');
      expect(agentNames).toContain('Coder');
      expect(agentNames).toContain('Debugger');
      expect(agentNames).toContain('Tester');
      expect(agentNames).toContain('Reviewer');
      expect(agentNames).toContain('VCS');
      expect(agentNames).toContain('Verifier');
      expect(agentNames).toHaveLength(7);
    });

    it('should NOT set agent or specialist agents when coordinatorMode is false', async () => {
      mockSession.config.coordinatorMode = false;
      const options = await builder.build();

      expect(options.agent).toBeUndefined();
      if (options.agents) {
        const agentNames = Object.keys(options.agents);
        expect(agentNames).not.toContain('Coordinator');
      }
    });

    it('should NOT set coordinator agent when coordinatorMode is undefined', async () => {
      const options = await builder.build();

      expect(options.agent).toBeUndefined();
    });

    it('should transition from non-coordinator to coordinator options (OFF -> ON)', async () => {
      mockSession.config.coordinatorMode = false;
      const optionsOff = await builder.build();
      expect(optionsOff.agent).toBeUndefined();

      mockSession.config.coordinatorMode = true;
      const builderOn = new QueryOptionsBuilder(mockContext);
      const optionsOn = await builderOn.build();
      expect(optionsOn.agent).toBe('Coordinator');
      expect(Object.keys(optionsOn.agents!)).toHaveLength(7);
    });

    it('should transition ON -> OFF -> ON correctly', async () => {
      mockSession.config.coordinatorMode = true;
      let options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.agent).toBe('Coordinator');

      mockSession.config.coordinatorMode = false;
      options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.agent).toBeUndefined();

      mockSession.config.coordinatorMode = true;
      options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.agent).toBe('Coordinator');
      expect(Object.keys(options.agents!)).toHaveLength(7);
    });

    it('should preserve user-defined agents alongside coordinator agents', async () => {
      mockSession.config.coordinatorMode = true;
      mockSession.config.agents = {
        'my-custom-agent': {
          description: 'Custom agent',
          prompt: 'You are custom.',
        },
      };
      const options = await builder.build();

      expect(options.agents!['my-custom-agent']).toBeDefined();
      expect(options.agents!['Coder']).toBeDefined();
      expect(options.agents!['Coordinator']).toBeDefined();
    });

    it('should inject worktree isolation into specialist agents but not coordinator', async () => {
      mockSession.config.coordinatorMode = true;
      mockSession.worktree = {
        worktreePath: '/worktree/path',
        mainRepoPath: '/main/repo',
        branch: 'session/test',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });
      const options = await newBuilder.build();

      const coordinatorPrompt = (options.agents!['Coordinator'] as { prompt: string }).prompt;
      expect(coordinatorPrompt).not.toContain('Git Worktree Isolation');

      const coderPrompt = (options.agents!['Coder'] as { prompt: string }).prompt;
      expect(coderPrompt).toContain('Git Worktree Isolation');
    });

    it('should NOT restrict session-level tools in coordinator mode (sub-agents need full tool access)', async () => {
      mockSession.config.coordinatorMode = true;
      const options = await builder.build();

      expect(options.tools).not.toEqual(['Task', 'TodoWrite', 'AskUserQuestion']);
    });

    it('should preserve sdkToolsPreset in coordinator mode', async () => {
      mockSession.config.coordinatorMode = true;
      mockSession.config.sdkToolsPreset = { type: 'preset', preset: 'claude_code' };
      const options = await builder.build();

      expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('should set allowedTools for all tools in coordinator mode', async () => {
      mockSession.config.coordinatorMode = true;
      mockSession.config.permissionMode = 'acceptEdits';
      const options = await builder.build();

      expect(options.allowedTools).toBeDefined();
      expect(options.allowedTools).toContain('Read');
      expect(options.allowedTools).toContain('Write');
      expect(options.allowedTools).toContain('Bash');
      expect(options.allowedTools).toContain('Edit');
      expect(options.allowedTools).toContain('Task');
    });

    it('should not add coordinator canUseTool wrapper', async () => {
      mockSession.config.coordinatorMode = true;
      const options = await builder.build();

      expect(options.canUseTool).toBeUndefined();
    });

    it('should preserve existing canUseTool when coordinatorMode is on', async () => {
      mockSession.config.coordinatorMode = true;

      const originalCallback = async () => {
        return { behavior: 'allow' as const };
      };
      builder.setCanUseTool(originalCallback);
      const options = await builder.build();

      expect(options.canUseTool).toBe(originalCallback);
    });
  });

  describe('provider-specific agent tool exposure', () => {
    afterEach(() => {
      resetProviderRegistry();
    });

    function registerCodexProvider(): void {
      resetProviderRegistry();
      const registry = getProviderRegistry();
      registry.register({
        id: 'anthropic-codex',
        displayName: 'OpenAI (Codex)',
        capabilities: {
          streaming: true,
          extendedThinking: false,
          maxContextWindow: 272000,
          functionCalling: true,
          vision: true,
        },
        isAvailable: () => true,
        getModels: async () => [],
        ownsModel: () => false,
        buildSdkConfig: () => ({ envVars: {}, isAnthropicCompatible: true }),
      } as Provider);
    }

    describe('ensureAgentTools (pure function)', () => {
      it('returns undefined unchanged for Anthropic provider', () => {
        const result = ensureAgentTools(
          undefined,
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic',
          'general'
        );
        expect(result).toBeUndefined();
      });

      it('returns undefined unchanged for anthropic-copilot provider', () => {
        const result = ensureAgentTools(
          undefined,
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic-copilot',
          'general'
        );
        expect(result).toBeUndefined();
      });

      it('expands undefined to full array for anthropic-codex provider', () => {
        const result = ensureAgentTools(
          undefined,
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic-codex',
          'general'
        );
        expect(Array.isArray(result)).toBe(true);
        expect(result).toContain('Agent');
        expect(result).toContain('Task');
        expect(result).toContain('TaskOutput');
        expect(result).toContain('TaskStop');
        expect(result).toContain('TaskCreate');
        expect(result).toContain('TaskGet');
        expect(result).toContain('TaskUpdate');
        expect(result).toContain('TaskList');
        expect(result).toContain('Read');
        expect(result).toContain('Write');
        expect(result).toContain('REPL');
        expect(result).toContain('Workflow');
        expect(result).toContain('CronCreate');
        expect(result).toContain('Artifact');
        expect(result).toContain('Monitor');
        expect(result).toContain('ShowOnboardingRolePicker');
      });

      it('expands undefined to full array for glm provider', () => {
        const result = ensureAgentTools(
          undefined,
          { Coordinator: { description: 'c', prompt: 'p' } },
          'glm',
          'general'
        );
        expect(Array.isArray(result)).toBe(true);
        expect(result).toContain('Agent');
        expect(result).toContain('Task');
      });

      it('appends missing agent tools to explicit array for non-native providers', () => {
        const result = ensureAgentTools(
          ['Read', 'Write'],
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic-codex',
          'general'
        );
        expect(result).toEqual(['Read', 'Write', 'Agent', 'Task', 'TaskOutput', 'TaskStop']);
      });

      it('does not duplicate existing agent tools in explicit array for non-native providers', () => {
        const result = ensureAgentTools(
          ['Read', 'Agent', 'Task', 'TaskOutput', 'TaskStop'],
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic-codex',
          'general'
        );
        expect(result).toEqual(['Read', 'Agent', 'Task', 'TaskOutput', 'TaskStop']);
      });

      it('preserves explicit array unchanged for Anthropic provider', () => {
        const result = ensureAgentTools(
          ['Read', 'Write'],
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic',
          'general'
        );
        expect(result).toEqual(['Read', 'Write']);
      });

      it('preserves explicit array unchanged for anthropic-copilot provider', () => {
        const result = ensureAgentTools(
          ['Read', 'Write'],
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic-copilot',
          'general'
        );
        expect(result).toEqual(['Read', 'Write']);
      });

      it('leaves space_chat sessions untouched even with agents', () => {
        const result = ensureAgentTools(
          undefined,
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic-codex',
          'space_chat'
        );
        expect(result).toBeUndefined();
      });

      it('returns original tools when no agents are configured', () => {
        const result = ensureAgentTools(undefined, undefined, 'anthropic-codex', 'general');
        expect(result).toBeUndefined();
      });

      it('preserves preset objects unchanged', () => {
        const preset = { type: 'preset' as const, preset: 'claude_code' as const };
        const result = ensureAgentTools(
          preset,
          { Coordinator: { description: 'c', prompt: 'p' } },
          'anthropic-codex',
          'general'
        );
        expect(result).toEqual(preset);
      });
    });

    describe('build() with non-Anthropic provider', () => {
      it('expands tools to full array for OpenAI (codex) when agents are configured', async () => {
        registerCodexProvider();
        mockSession.config.provider = 'anthropic-codex';
        mockSession.config.model = 'gpt-5.5';
        mockSession.config.agents = {
          'test-agent': {
            description: 'Test agent',
            prompt: 'Test prompt',
          },
        };
        const codexBuilder = new QueryOptionsBuilder(mockContext);
        const options = await codexBuilder.build();

        expect(Array.isArray(options.tools)).toBe(true);
        expect(options.tools).toContain('Task');
        expect(options.tools).toContain('TaskOutput');
        expect(options.tools).toContain('TaskStop');
        expect(options.tools).toContain('Read');
        expect(options.tools).toContain('Write');
      });

      it('expands tools for OpenAI coordinator mode', async () => {
        registerCodexProvider();
        mockSession.config.provider = 'anthropic-codex';
        mockSession.config.model = 'gpt-5.5';
        mockSession.config.coordinatorMode = true;
        const codexBuilder = new QueryOptionsBuilder(mockContext);
        const options = await codexBuilder.build();

        expect(Array.isArray(options.tools)).toBe(true);
        expect(options.tools).toContain('Task');
        expect(options.tools).toContain('TaskOutput');
        expect(options.tools).toContain('TaskStop');
      });

      it('leaves tools undefined for Anthropic when agents are configured', async () => {
        mockSession.config.agents = {
          'test-agent': {
            description: 'Test agent',
            prompt: 'Test prompt',
          },
        };
        const options = await builder.build();
        expect(options.tools).toBeUndefined();
      });

      it('preserves explicit tools array and appends missing agent tools for OpenAI', async () => {
        registerCodexProvider();
        mockSession.config.provider = 'anthropic-codex';
        mockSession.config.model = 'gpt-5.5';
        mockSession.config.sdkToolsPreset = ['Read', 'Write', 'Edit'];
        mockSession.config.agents = {
          'test-agent': {
            description: 'Test agent',
            prompt: 'Test prompt',
          },
        };
        const codexBuilder = new QueryOptionsBuilder(mockContext);
        const options = await codexBuilder.build();

        expect(options.tools).toEqual([
          'Read',
          'Write',
          'Edit',
          'Agent',
          'Task',
          'TaskOutput',
          'TaskStop',
        ]);
      });
    });
  });

  describe('file checkpointing configuration', () => {
    it('should enable file checkpointing by default', async () => {
      const options = await builder.build();
      expect(options.enableFileCheckpointing).toBe(true);
    });

    it('should enable file checkpointing when explicitly set to true', async () => {
      mockSession.config.enableFileCheckpointing = true;
      const options = await builder.build();
      expect(options.enableFileCheckpointing).toBe(true);
    });

    it('should disable file checkpointing when explicitly set to false', async () => {
      mockSession.config.enableFileCheckpointing = false;
      const options = await builder.build();
      expect(options.enableFileCheckpointing).toBe(false);
    });

    it('should include enableFileCheckpointing in debug logging', async () => {
      mockSession.config.enableFileCheckpointing = true;
      const options = await builder.build();
      expect('enableFileCheckpointing' in options).toBe(true);
    });
  });

  describe('skills injection', () => {
    const enabledSkills = [
      {
        id: 'skill-plugin-1',
        name: 'my-plugin',
        displayName: 'My Plugin',
        description: 'A plugin skill',
        sourceType: 'plugin' as const,
        config: { type: 'plugin' as const, pluginPath: '/path/to/plugin' },
        enabled: true,
        builtIn: false,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      },
      {
        id: 'skill-mcp-1',
        name: 'test-search',
        displayName: 'Test Search',
        description: 'Web search via test MCP',
        sourceType: 'mcp_server' as const,
        config: { type: 'mcp_server' as const, appMcpServerId: 'mcp-server-uuid' },
        enabled: true,
        builtIn: false,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      },
      {
        id: 'skill-disabled-1',
        name: 'disabled-skill',
        displayName: 'Disabled Skill',
        description: 'A disabled skill',
        sourceType: 'plugin' as const,
        config: { type: 'plugin' as const, pluginPath: '/path/to/disabled' },
        enabled: false,
        builtIn: false,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      },
    ];

    const mockAppMcpServer = {
      id: 'mcp-server-uuid',
      name: 'test-search-server',
      description: 'Test Search MCP',
      sourceType: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'test-mcp'],
      env: { TEST_API_KEY: 'test-key' },
      enabled: true,
    };

    it('should inject plugin skills as plugins option', async () => {
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [enabledSkills[0]]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([{ type: 'local', path: '/path/to/plugin' }]);
    });

    it('should inject MCP server skills as mcpServers entries', async () => {
      const mockAppMcpServerRepo = {
        get: mock(() => mockAppMcpServer),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [enabledSkills[1]]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.mcpServers).toBeDefined();
      expect(options.mcpServers!['test-search']).toEqual({
        command: 'npx',
        args: ['-y', 'test-mcp'],
        env: { TEST_API_KEY: 'test-key' },
      });
    });

    it('should exclude disabled skills', async () => {
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [enabledSkills[0]]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([{ type: 'local', path: '/path/to/plugin' }]);
    });

    it('should not inject anything when skillsManager is not provided', async () => {
      const builder = new QueryOptionsBuilder(mockContext);
      const options = await builder.build();

      expect(options.plugins).toBeUndefined();
    });

    it('should merge skill plugins with existing config plugins', async () => {
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [enabledSkills[0]]),
      };
      mockSession.config.plugins = [{ type: 'local', path: '/existing/plugin' }];
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([
        { type: 'local', path: '/existing/plugin' },
        { type: 'local', path: '/path/to/plugin' },
      ]);
    });

    it('should merge skill MCP servers with existing config mcpServers', async () => {
      const mockAppMcpServerRepo = {
        get: mock(() => mockAppMcpServer),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [enabledSkills[1]]),
      };
      mockSession.config.mcpServers = {
        'existing-server': { command: 'existing-cmd' },
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.mcpServers!['existing-server']).toEqual({ command: 'existing-cmd' });
      expect(options.mcpServers!['test-search']).toEqual({
        command: 'npx',
        args: ['-y', 'test-mcp'],
        env: { TEST_API_KEY: 'test-key' },
      });
    });

    it('should skip disabled AppMcpServer entries even when the wrapping skill is enabled', async () => {
      const disabledAppMcpServer = {
        ...mockAppMcpServer,
        enabled: false,
      };
      const mockAppMcpServerRepo = {
        get: mock(() => disabledAppMcpServer),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [enabledSkills[1]]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.mcpServers).toBeUndefined();
    });

    it('should skip MCP server skills when referenced app_mcp_servers entry is deleted', async () => {
      const mockAppMcpServerRepo = {
        get: mock(() => null),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [enabledSkills[1]]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.mcpServers).toBeUndefined();
    });

    it('should make skill-injected MCP servers available in strictMcpConfig sessions', async () => {
      const mockAppMcpServerRepo = {
        get: mock(() => mockAppMcpServer),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [enabledSkills[1]]),
      };
      mockSession.type = 'space_chat';
      mockSession.config.permissionMode = 'acceptEdits';
      mockSession.config.mcpServers = {
        'space-agent-tools': { command: 'space-cmd' },
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.strictMcpConfig).toBe(true);
      expect(options.mcpServers!['test-search']).toEqual({
        command: 'npx',
        args: ['-y', 'test-mcp'],
        env: { TEST_API_KEY: 'test-key' },
      });
      expect(options.mcpServers!['space-agent-tools']).toEqual({ command: 'space-cmd' });
      expect(options.allowedTools).toContain('test-search__*');
    });

    it('should inject builtin skills as local plugins pointing at the wrapper plugin directory', async () => {
      const builtinSkill = {
        id: 'skill-builtin-1',
        name: 'playwright',
        displayName: 'Playwright',
        description: 'A builtin skill',
        sourceType: 'builtin' as const,
        config: { type: 'builtin' as const, commandName: 'playwright' },
        enabled: true,
        builtIn: true,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [builtinSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toBeDefined();
      expect(options.plugins).toHaveLength(1);
      expect(options.plugins![0]).toMatchObject({ type: 'local' });
      const pluginPath = (options.plugins![0] as { type: string; path: string }).path;
      expect(pluginPath).toContain('.hyperneo/skill-plugins/playwright');
      expect(pluginPath).not.toMatch(/\.hyperneo\/skills\/playwright(?:$|\/)/);
      expect(options.mcpServers).toBeUndefined();
    });

    it('should inject space-only builtin skills only for sessions scoped to a Space', async () => {
      const spaceSkill = {
        id: 'skill-builtin-space-1',
        name: 'space-coordination',
        displayName: 'Space Coordination',
        description: 'Space-only coordination fallback',
        sourceType: 'builtin' as const,
        config: { type: 'builtin' as const, commandName: 'space-coordination', spaceOnly: true },
        enabled: true,
        builtIn: true,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [spaceSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };

      let options = await new QueryOptionsBuilder(context).build();
      expect(options.plugins).toBeUndefined();

      mockSession.context = { spaceId: 'space-1' };
      options = await new QueryOptionsBuilder(context).build();
      expect(options.plugins).toBeDefined();
      expect(options.plugins).toHaveLength(1);
      const pluginPath = (options.plugins![0] as { type: string; path: string }).path;
      expect(pluginPath).toContain('.hyperneo/skill-plugins/space-coordination');
    });

    it('should not inject a disabled builtin skill', async () => {
      const builtinSkill = {
        id: 'skill-builtin-2',
        name: 'playwright-interactive',
        displayName: 'Playwright Interactive',
        description: 'A disabled builtin skill',
        sourceType: 'builtin' as const,
        config: { type: 'builtin' as const, commandName: 'playwright-interactive' },
        enabled: false,
        builtIn: true,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => []),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      void builtinSkill;
      expect(options.plugins).toBeUndefined();
    });

    it('should handle SSE MCP server skills', async () => {
      const sseAppMcpServer = {
        id: 'sse-server-uuid',
        name: 'sse-server',
        sourceType: 'sse' as const,
        url: 'http://localhost:3001/sse',
        headers: { Authorization: 'Bearer token' },
        enabled: true,
      };
      const sseSkill = {
        id: 'skill-sse-1',
        name: 'sse-skill',
        displayName: 'SSE Skill',
        description: 'An SSE MCP skill',
        sourceType: 'mcp_server' as const,
        config: { type: 'mcp_server' as const, appMcpServerId: 'sse-server-uuid' },
        enabled: true,
        builtIn: false,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      };
      const mockAppMcpServerRepo = {
        get: mock(() => sseAppMcpServer),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [sseSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.mcpServers!['sse-skill']).toEqual({
        type: 'sse',
        url: 'http://localhost:3001/sse',
        headers: { Authorization: 'Bearer token' },
      });
    });

    it('should handle HTTP MCP server skills', async () => {
      const httpAppMcpServer = {
        id: 'http-server-uuid',
        name: 'http-server',
        sourceType: 'http' as const,
        url: 'http://localhost:3002/mcp',
        enabled: true,
      };
      const httpSkill = {
        id: 'skill-http-1',
        name: 'http-skill',
        displayName: 'HTTP Skill',
        description: 'An HTTP MCP skill',
        sourceType: 'mcp_server' as const,
        config: { type: 'mcp_server' as const, appMcpServerId: 'http-server-uuid' },
        enabled: true,
        builtIn: false,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      };
      const mockAppMcpServerRepo = {
        get: mock(() => httpAppMcpServer),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [httpSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.mcpServers!['http-skill']).toEqual({
        type: 'http',
        url: 'http://localhost:3002/mcp',
      });
    });

    describe('mcp_enablement override filtering (MCP M6)', () => {
      const targetAppServer = {
        id: 'mcp-server-uuid',
        name: 'test-search-server',
        description: 'Test Search MCP',
        sourceType: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'test-mcp'],
        env: { TEST_API_KEY: 'test-key' },
        enabled: true,
      };
      const mcpSkill = {
        id: 'skill-mcp-1',
        name: 'test-search',
        displayName: 'Test Search',
        description: 'Web search via test MCP',
        sourceType: 'mcp_server' as const,
        config: { type: 'mcp_server' as const, appMcpServerId: 'mcp-server-uuid' },
        enabled: true,
        builtIn: false,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      };

      function buildContext(
        overrides: {
          scopeType: 'session' | 'room' | 'space';
          scopeId: string;
          serverId: string;
          enabled: boolean;
        }[]
      ): QueryOptionsBuilderContext {
        const mockAppMcpServerRepo = {
          get: mock(() => targetAppServer),
          list: mock(() => [targetAppServer]),
        };
        const mockEnablementRepo = {
          listForScopes: mock(() =>
            overrides.map((ov) => ({
              scopeType: ov.scopeType,
              scopeId: ov.scopeId,
              serverId: ov.serverId,
              enabled: ov.enabled,
            }))
          ),
        };
        const mockSkillsManager = {
          getEnabledSkills: mock(() => [mcpSkill]),
          listSkills: mock(() => [mcpSkill]),
        };
        return {
          session: mockSession,
          settingsManager: mockSettingsManager,
          skillsManager:
            mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
          appMcpServerRepo:
            mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
          mcpEnablementRepo:
            mockEnablementRepo as unknown as import('../../../../src/storage/repositories/mcp-enablement-repository').McpEnablementRepository,
        };
      }

      it('excludes a skill-wrapped MCP server disabled by a session override', async () => {
        const ctx = buildContext([
          {
            scopeType: 'session',
            scopeId: mockSession.id,
            serverId: 'mcp-server-uuid',
            enabled: false,
          },
        ]);
        const builder = new QueryOptionsBuilder(ctx);
        const options = await builder.build();

        expect(options.mcpServers?.['test-search']).toBeUndefined();
      });

      it('includes the server when the session override explicitly enables a globally-disabled registry row', async () => {
        const disabledAppServer = { ...targetAppServer, enabled: false };
        const mockAppMcpServerRepo = {
          get: mock(() => disabledAppServer),
          list: mock(() => [disabledAppServer]),
        };
        const mockEnablementRepo = {
          listForScopes: mock(() => [
            {
              scopeType: 'session' as const,
              scopeId: mockSession.id,
              serverId: 'mcp-server-uuid',
              enabled: true,
            },
          ]),
        };
        const mockSkillsManager = {
          getEnabledSkills: mock(() => [mcpSkill]),
          listSkills: mock(() => [mcpSkill]),
        };
        const ctx: QueryOptionsBuilderContext = {
          session: mockSession,
          settingsManager: mockSettingsManager,
          skillsManager:
            mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
          appMcpServerRepo:
            mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
          mcpEnablementRepo:
            mockEnablementRepo as unknown as import('../../../../src/storage/repositories/mcp-enablement-repository').McpEnablementRepository,
        };
        const builder = new QueryOptionsBuilder(ctx);
        const options = await builder.build();

        expect(options.mcpServers?.['test-search']).toEqual({
          command: 'npx',
          args: ['-y', 'test-mcp'],
          env: { TEST_API_KEY: 'test-key' },
        });
        expect(options.mcpServers?.['test-search-server']).toBeUndefined();
      });

      it('honours the session > room > space > registry precedence chain', async () => {
        mockSession.context = { roomId: 'room-1', spaceId: 'space-1' };
        const ctxRoomDisables = buildContext([
          { scopeType: 'room', scopeId: 'room-1', serverId: 'mcp-server-uuid', enabled: false },
        ]);
        const builder1 = new QueryOptionsBuilder(ctxRoomDisables);
        const options1 = await builder1.build();
        expect(options1.mcpServers?.['test-search']).toBeUndefined();

        const ctxSessionReenables = buildContext([
          { scopeType: 'room', scopeId: 'room-1', serverId: 'mcp-server-uuid', enabled: false },
          {
            scopeType: 'session',
            scopeId: mockSession.id,
            serverId: 'mcp-server-uuid',
            enabled: true,
          },
        ]);
        const builder2 = new QueryOptionsBuilder(ctxSessionReenables);
        const options2 = await builder2.build();
        expect(options2.mcpServers?.['test-search']).toBeDefined();
      });

      it('falls back to the registry default when no enablement repo is provided', async () => {
        const disabledAppServer = { ...targetAppServer, enabled: false };
        const mockAppMcpServerRepo = {
          get: mock(() => disabledAppServer),
          list: mock(() => [disabledAppServer]),
        };
        const mockSkillsManager = { getEnabledSkills: mock(() => [mcpSkill]) };
        const ctx: QueryOptionsBuilderContext = {
          session: mockSession,
          settingsManager: mockSettingsManager,
          skillsManager:
            mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
          appMcpServerRepo:
            mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
        };
        const builder = new QueryOptionsBuilder(ctx);
        const options = await builder.build();
        expect(options.mcpServers?.['test-search']).toBeUndefined();
      });
    });
  });

  describe('configured registry MCP servers (skill-less path)', () => {
    type RepoServer = {
      id: string;
      name: string;
      sourceType: 'stdio' | 'sse' | 'http';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      enabled: boolean;
    };

    function buildRegistryContext(
      servers: RepoServer[],
      {
        overrides = [],
        skills = [],
      }: {
        overrides?: Array<{
          scopeType: 'session' | 'room' | 'space';
          scopeId: string;
          serverId: string;
          enabled: boolean;
        }>;
        skills?: Array<{
          id: string;
          name: string;
          sourceType: 'mcp_server';
          config: { type: 'mcp_server'; appMcpServerId: string };
          enabled: boolean;
        }>;
      } = {}
    ): QueryOptionsBuilderContext {
      const mockAppMcpServerRepo = {
        get: mock((id: string) => servers.find((s) => s.id === id) ?? null),
        list: mock(() => servers),
      };
      const mockEnablementRepo = {
        listForScopes: mock(() =>
          overrides.map((ov) => ({
            scopeType: ov.scopeType,
            scopeId: ov.scopeId,
            serverId: ov.serverId,
            enabled: ov.enabled,
          }))
        ),
      };
      const enabledSkills = skills.filter((s) => s.enabled);
      const mockSkillsManager = {
        getEnabledSkills: mock(() => enabledSkills),
        listSkills: mock(() => skills),
      };
      return {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
        mcpEnablementRepo:
          mockEnablementRepo as unknown as import('../../../../src/storage/repositories/mcp-enablement-repository').McpEnablementRepository,
      };
    }

    it('attaches a configured registry server that has no wrapping skill', async () => {
      const ctx = buildRegistryContext([
        {
          id: 'srv-cbm',
          name: 'codebase-memory-mcp',
          sourceType: 'stdio',
          command: 'npx',
          args: ['-y', 'codebase-memory-mcp'],
          enabled: true,
        },
      ]);
      const builder = new QueryOptionsBuilder(ctx);
      const options = await builder.build();

      expect(options.mcpServers?.['codebase-memory-mcp']).toEqual({
        command: 'npx',
        args: ['-y', 'codebase-memory-mcp'],
      });
      expect(options.strictMcpConfig).toBe(true);
    });

    it('omits a disabled registry server', async () => {
      const ctx = buildRegistryContext([
        {
          id: 'srv-cbm',
          name: 'codebase-memory-mcp',
          sourceType: 'stdio',
          command: 'npx',
          enabled: false,
        },
      ]);
      const builder = new QueryOptionsBuilder(ctx);
      const options = await builder.build();

      expect(options.mcpServers?.['codebase-memory-mcp']).toBeUndefined();
    });

    it('omits an invalid registry server (missing command) instead of emitting a broken config', async () => {
      const ctx = buildRegistryContext([
        {
          id: 'srv-broken',
          name: 'broken-server',
          sourceType: 'stdio',
          command: '',
          enabled: true,
        },
      ]);
      const builder = new QueryOptionsBuilder(ctx);
      const options = await builder.build();

      expect(options.mcpServers?.['broken-server']).toBeUndefined();
    });

    it('preserves a genuine runtime MCP server alongside a registry server (no name collision)', async () => {
      const ctx = buildRegistryContext([
        {
          id: 'srv-1',
          name: 'registry-srv',
          sourceType: 'stdio',
          command: 'registry-cmd',
          enabled: true,
        },
      ]);
      mockSession.config.mcpServers = { 'space-agent-tools': { command: 'runtime-cmd' } };
      const builder = new QueryOptionsBuilder(ctx);
      const options = await builder.build();

      expect(options.mcpServers?.['space-agent-tools']).toEqual({ command: 'runtime-cmd' });
      expect(options.mcpServers?.['registry-srv']).toEqual({ command: 'registry-cmd' });
      delete mockSession.config.mcpServers;
    });

    it('does not let a registry server named like a runtime key shadow the genuine runtime server', async () => {
      const ctx = buildRegistryContext([
        {
          id: 'srv-evil',
          name: 'space-agent-tools',
          sourceType: 'stdio',
          command: 'evil-registry-cmd',
          enabled: true,
        },
      ]);
      mockSession.config.mcpServers = { 'space-agent-tools': { command: 'genuine-runtime-cmd' } };
      const builder = new QueryOptionsBuilder(ctx);
      const options = await builder.build();

      expect(options.mcpServers?.['space-agent-tools']).toEqual({ command: 'genuine-runtime-cmd' });
      delete mockSession.config.mcpServers;
    });

    it('detaches a registry server that is deleted (removed from the registry)', async () => {
      const registry = [
        {
          id: 'srv-del',
          name: 'doomed-srv',
          sourceType: 'stdio' as const,
          command: 'npx',
          enabled: true,
        },
      ];
      const ctx = buildRegistryContext(registry);
      const builder = new QueryOptionsBuilder(ctx);

      expect(builder.getEffectiveMcpServers()?.['doomed-srv']).toBeDefined();

      registry.pop();
      expect(builder.getEffectiveMcpServers()?.['doomed-srv']).toBeUndefined();
    });

    it('detaches the old name when a registry server is renamed', async () => {
      const registry = [
        {
          id: 'srv-rn',
          name: 'old-name',
          sourceType: 'stdio' as const,
          command: 'npx',
          enabled: true,
        },
      ];
      const ctx = buildRegistryContext(registry);
      const builder = new QueryOptionsBuilder(ctx);

      expect(builder.getEffectiveMcpServers()?.['old-name']).toBeDefined();

      registry[0]!.name = 'new-name';
      const eff = builder.getEffectiveMcpServers();
      expect(eff?.['old-name']).toBeUndefined();
      expect(eff?.['new-name']).toBeDefined();
    });

    it('omits a skill-less registry server disabled by a session-scope override', async () => {
      const ctx = buildRegistryContext(
        [
          {
            id: 'srv-cbm',
            name: 'codebase-memory-mcp',
            sourceType: 'stdio',
            command: 'npx',
            enabled: true,
          },
        ],
        {
          overrides: [
            {
              scopeType: 'session',
              scopeId: mockSession.id,
              serverId: 'srv-cbm',
              enabled: false,
            },
          ],
        }
      );
      const builder = new QueryOptionsBuilder(ctx);
      const options = await builder.build();

      expect(options.mcpServers?.['codebase-memory-mcp']).toBeUndefined();
    });

    it('does not double-attach a skilled server (skill name wins, registry name absent)', async () => {
      const ctx = buildRegistryContext(
        [
          {
            id: 'srv-1',
            name: 'registry-server-name',
            sourceType: 'stdio',
            command: 'npx',
            args: ['-y', 'tool'],
            enabled: true,
          },
        ],
        {
          skills: [
            {
              id: 'skill-1',
              name: 'my-skill-name',
              sourceType: 'mcp_server',
              config: { type: 'mcp_server', appMcpServerId: 'srv-1' },
              enabled: true,
            },
          ],
        }
      );
      const builder = new QueryOptionsBuilder(ctx);
      const options = await builder.build();

      expect(options.mcpServers?.['my-skill-name']).toEqual({
        command: 'npx',
        args: ['-y', 'tool'],
      });
      expect(options.mcpServers?.['registry-server-name']).toBeUndefined();
    });

    it('keeps a server detached when its wrapping skill is disabled (skill gate preserved)', async () => {
      const ctx = buildRegistryContext(
        [
          {
            id: 'srv-1',
            name: 'registry-server-name',
            sourceType: 'stdio',
            command: 'npx',
            enabled: true,
          },
        ],
        {
          skills: [
            {
              id: 'skill-1',
              name: 'my-skill-name',
              sourceType: 'mcp_server',
              config: { type: 'mcp_server', appMcpServerId: 'srv-1' },
              enabled: false,
            },
          ],
        }
      );
      const builder = new QueryOptionsBuilder(ctx);
      const options = await builder.build();

      expect(options.mcpServers?.['my-skill-name']).toBeUndefined();
      expect(options.mcpServers?.['registry-server-name']).toBeUndefined();
    });

    it('getEffectiveMcpServers recomputes to reflect enable/disable (active-session reconciliation)', async () => {
      const server = {
        id: 'srv-cbm',
        name: 'codebase-memory-mcp',
        sourceType: 'stdio' as const,
        command: 'npx',
        enabled: true,
      };
      const ctx = buildRegistryContext([server]);
      const builder = new QueryOptionsBuilder(ctx);

      expect(builder.getEffectiveMcpServers()?.['codebase-memory-mcp']).toBeDefined();

      server.enabled = false;
      const options = await builder.build();
      expect(options.mcpServers?.['codebase-memory-mcp']).toBeUndefined();
    });
  });

  describe('skill enablement overrides', () => {
    const pluginSkill = {
      id: 'skill-plugin-room-1',
      name: 'room-plugin',
      displayName: 'Room Plugin',
      description: 'Plugin skill used in skill override tests',
      sourceType: 'plugin' as const,
      config: { type: 'plugin' as const, pluginPath: '/plugins/room-plugin' },
      enabled: true,
      builtIn: false,
      validationStatus: 'valid' as const,
      createdAt: Date.now(),
    };

    const mcpSkill = {
      id: 'skill-mcp-room-1',
      name: 'room-mcp',
      displayName: 'Room MCP',
      description: 'MCP skill used in skill override tests',
      sourceType: 'mcp_server' as const,
      config: { type: 'mcp_server' as const, appMcpServerId: 'mcp-room-uuid' },
      enabled: true,
      builtIn: false,
      validationStatus: 'valid' as const,
      createdAt: Date.now(),
    };

    const mockRoomMcpServer = {
      id: 'mcp-room-uuid',
      name: 'room-mcp-server',
      sourceType: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'room-mcp'],
      enabled: true,
    };

    it('should exclude a plugin skill disabled by a skill override', async () => {
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        skillOverrides: [{ skillId: pluginSkill.id, enabled: false }],
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toBeUndefined();
    });

    it('should exclude an MCP server skill disabled by a skill override', async () => {
      const mockAppMcpServerRepo = {
        get: mock(() => mockRoomMcpServer),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [mcpSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
        skillOverrides: [{ skillId: mcpSkill.id, enabled: false }],
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.mcpServers).toBeUndefined();
    });

    it('should still include a plugin skill when skill override has enabled=true', async () => {
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        skillOverrides: [{ skillId: pluginSkill.id, enabled: true }],
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/room-plugin' }]);
    });

    it('should apply skill override only to the matching skill ID', async () => {
      const anotherPlugin = {
        id: 'skill-plugin-other',
        name: 'other-plugin',
        displayName: 'Other Plugin',
        description: 'Another plugin not targeted by the override',
        sourceType: 'plugin' as const,
        config: { type: 'plugin' as const, pluginPath: '/plugins/other-plugin' },
        enabled: true,
        builtIn: false,
        validationStatus: 'valid' as const,
        createdAt: Date.now(),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill, anotherPlugin]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        skillOverrides: [{ skillId: pluginSkill.id, enabled: false }],
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/other-plugin' }]);
    });

    it('should include all skills when skillOverrides is empty', async () => {
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        skillOverrides: [],
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/room-plugin' }]);
    });

    it('should include all skills when skillOverrides is not provided', async () => {
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/room-plugin' }]);
    });
  });

  describe('session disabledSkills override', () => {
    const pluginSkill = {
      id: 'skill-plugin-session-1',
      name: 'session-plugin',
      displayName: 'Session Plugin',
      description: 'Plugin skill used in session disable tests',
      sourceType: 'plugin' as const,
      config: { type: 'plugin' as const, pluginPath: '/plugins/session-plugin' },
      enabled: true,
      builtIn: false,
      validationStatus: 'valid' as const,
      createdAt: Date.now(),
    };

    const mcpSkill = {
      id: 'skill-mcp-session-1',
      name: 'session-mcp',
      displayName: 'Session MCP',
      description: 'MCP skill used in session disable tests',
      sourceType: 'mcp_server' as const,
      config: { type: 'mcp_server' as const, appMcpServerId: 'mcp-session-uuid' },
      enabled: true,
      builtIn: false,
      validationStatus: 'valid' as const,
      createdAt: Date.now(),
    };

    const builtinSkill = {
      id: 'skill-builtin-session-1',
      name: 'session-builtin',
      displayName: 'Session Builtin',
      description: 'Builtin skill used in session disable tests',
      sourceType: 'builtin' as const,
      config: { type: 'builtin' as const, commandName: 'session-builtin' },
      enabled: true,
      builtIn: true,
      validationStatus: 'valid' as const,
      createdAt: Date.now(),
    };

    const mockSessionMcpServer = {
      id: 'mcp-session-uuid',
      name: 'session-mcp-server',
      sourceType: 'stdio' as const,
      command: 'npx',
      args: ['-y', 'session-mcp'],
      enabled: true,
    };

    it('excludes a plugin skill listed in tools.disabledSkills', async () => {
      mockSession.config.tools = { disabledSkills: [pluginSkill.id] };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toBeUndefined();
    });

    it('excludes a builtin skill listed in tools.disabledSkills', async () => {
      mockSession.config.tools = { disabledSkills: [builtinSkill.id] };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [builtinSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toBeUndefined();
    });

    it('excludes an mcp_server skill listed in tools.disabledSkills', async () => {
      mockSession.config.tools = { disabledSkills: [mcpSkill.id] };
      const mockAppMcpServerRepo = {
        get: mock(() => mockSessionMcpServer),
      };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [mcpSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        appMcpServerRepo:
          mockAppMcpServerRepo as unknown as import('../../../../src/storage/repositories/app-mcp-server-repository').AppMcpServerRepository,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.mcpServers).toBeUndefined();
    });

    it('only filters skills whose IDs appear in the disable list', async () => {
      const otherPlugin = {
        ...pluginSkill,
        id: 'skill-plugin-session-other',
        name: 'other-session-plugin',
        config: { type: 'plugin' as const, pluginPath: '/plugins/other-session-plugin' },
      };
      mockSession.config.tools = { disabledSkills: [pluginSkill.id] };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill, otherPlugin]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/other-session-plugin' }]);
    });

    it('is additive with skill overrides (explicit disable wins even when session list is empty)', async () => {
      mockSession.config.tools = { disabledSkills: [] };
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
        skillOverrides: [{ skillId: pluginSkill.id, enabled: false }],
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toBeUndefined();
    });

    it('is a no-op when tools.disabledSkills is undefined', async () => {
      mockSession.config.tools = {};
      const mockSkillsManager = {
        getEnabledSkills: mock(() => [pluginSkill]),
      };
      const context: QueryOptionsBuilderContext = {
        session: mockSession,
        settingsManager: mockSettingsManager,
        skillsManager:
          mockSkillsManager as unknown as import('../../../../src/lib/skills-manager').SkillsManager,
      };
      const builder = new QueryOptionsBuilder(context);
      const options = await builder.build();

      expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/session-plugin' }]);
    });
  });

  describe('regression: Skill, WebSearch, WebFetch tool availability (Task 7.1)', () => {
    beforeEach(() => {
      mockSession.type = 'space_chat';
    });

    it('space_chat sessions include WebSearch in tools list', async () => {
      const options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.tools).toContain('WebSearch');
    });

    it('space_chat sessions include WebFetch in tools list', async () => {
      const options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.tools).toContain('WebFetch');
    });

    it('space_chat allowedTools includes WebSearch, WebFetch', async () => {
      mockSession.config.permissionMode = 'acceptEdits';
      const options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.allowedTools).toContain('WebSearch');
      expect(options.allowedTools).toContain('WebFetch');
    });

    it('coordinator mode allowedTools includes Skill, WebSearch, WebFetch', async () => {
      mockSession.config.coordinatorMode = true;
      mockSession.config.permissionMode = 'acceptEdits';
      const options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.allowedTools).toContain('Skill');
      expect(options.allowedTools).toContain('WebSearch');
      expect(options.allowedTools).toContain('WebFetch');
    });
  });

  describe('always-on agent/agents propagation (room agents)', () => {
    const coderExplorerDef = {
      description: 'Read-only codebase explorer.',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      model: 'inherit' as const,
      prompt: 'You are an Explorer Agent.',
    };
    const coderTesterDef = {
      description: 'Test writer and runner.',
      tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
      model: 'inherit' as const,
      prompt: 'You are a Tester Agent.',
    };
    const coderAgentDef = {
      description: 'Implementation agent.',
      tools: ['Task', 'TaskOutput', 'TaskStop', 'Read', 'Write', 'Edit', 'Bash'],
      model: 'inherit' as const,
      prompt: 'You are a Coder Agent.',
    };

    it('preserves config.agent exactly when coordinatorMode is off', async () => {
      mockSession.config.agent = 'Coder';
      mockSession.config.agents = {
        Coder: coderAgentDef,
        'coder-explorer': coderExplorerDef,
        'coder-tester': coderTesterDef,
      };
      mockSession.config.coordinatorMode = false;

      const options = await builder.build();

      expect(options.agent).toBe('Coder');
    });

    it('preserves config.agents map exactly when coordinatorMode is off', async () => {
      mockSession.config.agent = 'Coder';
      mockSession.config.agents = {
        Coder: coderAgentDef,
        'coder-explorer': coderExplorerDef,
        'coder-tester': coderTesterDef,
      };
      mockSession.config.coordinatorMode = false;

      const options = await builder.build();

      expect(Object.keys(options.agents!)).toEqual(['Coder', 'coder-explorer', 'coder-tester']);
      expect(options.agents!['Coder']).toEqual(coderAgentDef);
      expect(options.agents!['coder-explorer']).toEqual(coderExplorerDef);
      expect(options.agents!['coder-tester']).toEqual(coderTesterDef);
    });

    it('preserves config.agents when coordinatorMode is undefined (always-on default)', async () => {
      mockSession.config.agent = 'Coder';
      mockSession.config.agents = {
        Coder: coderAgentDef,
        'coder-explorer': coderExplorerDef,
        'coder-tester': coderTesterDef,
      };

      const options = await builder.build();

      expect(options.agent).toBe('Coder');
      expect(Object.keys(options.agents!)).toHaveLength(3);
      expect(options.agents!['coder-explorer']).toEqual(coderExplorerDef);
    });

    it('coordinatorMode ON overwrites room agent config with coordinator agents', async () => {
      mockSession.config.agent = 'Coder';
      mockSession.config.agents = {
        Coder: coderAgentDef,
        'coder-explorer': coderExplorerDef,
      };
      mockSession.config.coordinatorMode = true;

      const options = await builder.build();

      expect(options.agent).toBe('Coordinator');
      expect(options.agents!['Coordinator']).toBeDefined();
      expect(options.agents!['Debugger']).toBeDefined();
      expect(options.agents!['Coder']).toBeDefined();
    });

    it('coordinatorMode ON merges room custom agents into coordinator agents map', async () => {
      mockSession.config.agents = {
        'my-custom': { description: 'Custom agent', prompt: 'Custom.' },
      };
      mockSession.config.coordinatorMode = true;

      const options = await builder.build();

      expect(options.agent).toBe('Coordinator');
      expect(options.agents!['my-custom']).toBeDefined();
      expect(options.agents!['Coordinator']).toBeDefined();
      expect(options.agents!['Coder']).toBeDefined();
    });

    it('worktree isolation is in system prompt but NOT injected into room agent sub-agents', async () => {
      mockSession.config.agent = 'Coder';
      mockSession.config.agents = {
        Coder: coderAgentDef,
        'coder-explorer': coderExplorerDef,
        'coder-tester': coderTesterDef,
      };
      mockSession.worktree = {
        worktreePath: '/worktree/path',
        mainRepoPath: '/main/repo',
        branch: 'task/my-task',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });

      const options = await newBuilder.build();

      const systemPrompt = options.systemPrompt as { append?: string };
      expect(systemPrompt.append).toContain('Git Worktree Isolation');

      expect((options.agents!['coder-explorer'] as { prompt: string }).prompt).toBe(
        coderExplorerDef.prompt
      );
      expect((options.agents!['coder-tester'] as { prompt: string }).prompt).toBe(
        coderTesterDef.prompt
      );
    });

    it('coordinator mode injects worktree isolation into specialist agent prompts', async () => {
      mockSession.config.coordinatorMode = true;
      mockSession.worktree = {
        worktreePath: '/worktree/path',
        mainRepoPath: '/main/repo',
        branch: 'task/my-task',
      };
      const newBuilder = new QueryOptionsBuilder({
        session: mockSession,
        settingsManager: mockSettingsManager,
      });

      const options = await newBuilder.build();

      const coderPrompt = (options.agents!['Coder'] as { prompt: string }).prompt;
      expect(coderPrompt).toContain('Git Worktree Isolation');

      const coordinatorPrompt = (options.agents!['Coordinator'] as { prompt: string }).prompt;
      expect(coordinatorPrompt).not.toContain('Git Worktree Isolation');
    });
  });
});
