/**
 * QueryOptionsBuilder Tests
 *
 * Tests SDK query options construction from session config.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Session } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { Provider } from '@neokai/shared/provider';
import { homedir } from 'os';
import {
  buildProviderSettings,
  ensureAgentTools,
  QueryOptionsBuilder,
  type QueryOptionsBuilderContext,
} from '../../../../src/lib/agent/query-options-builder';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';
import type { SettingsManager } from '../../../../src/lib/settings-manager';
import { SkillsManager } from '../../../../src/lib/skills-manager';
import { AppMcpServerRepository } from '../../../../src/storage/repositories/app-mcp-server-repository';
import { SkillRepository } from '../../../../src/storage/repositories/skill-repository';
import { createTables } from '../../../../src/storage/schema';
import { noOpReactiveDb } from '../../../helpers/reactive-database';
import { setModelsCache } from '../../../../src/lib/model-service';

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
      getGlobalSettings: mock(() => ({ settingSources: ['user', 'project', 'local'] })),
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
      expect(options.permissionMode).toBe('bypassPermissions');
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

    it('should include env when configured', async () => {
      mockSession.config.env = { MY_VAR: 'value' };
      const options = await builder.build();
      expect(options.env).toMatchObject({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MY_VAR: 'value',
      });
    });

    it('should filter user auto-compact env overrides so provider cleanup owns the SDK env', async () => {
      mockSettingsManager.getGlobalSettings = mock(() => ({
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000', KEEP_GLOBAL: 'global' },
        settingSources: ['user', 'project', 'local'],
      }));
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
    });

    it('should filter provider-managed auto-compact env overrides for bridge providers', async () => {
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
    });

    it('should not override SDK auto-compaction settings for native anthropic provider', async () => {
      // Default provider is anthropic — SDK already knows correct context window
      const options = await builder.build();
      expect(options.settings).toBeUndefined();
    });

    it('should remove undefined values from options', async () => {
      const options = await builder.build();
      // Should not have undefined values
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
      // anthropic-codex routes through recognised Anthropic model IDs whose
      // PP() capacities cover the real Codex windows, so SDK auto-compact is
      // trusted. Belt-and-suspenders with CLAUDE_CODE_AUTO_COMPACT_WINDOW env.
      expect(buildProviderSettings('anthropic-codex')).toBeUndefined();
      expect(buildProviderSettings('anthropic-codex', 272_000)).toBeUndefined();
    });

    it('should not override SDK auto-compaction for GLM (env var + [1m] suffix configures SDK correctly)', () => {
      // GLM sets CLAUDE_CODE_AUTO_COMPACT_WINDOW per model in buildSdkConfig,
      // and the [1m] suffix on glm-5.2[1m] is recognised by PP(). The SDK's
      // effective window matches metadata, so SDK auto-compact fires at the
      // correct threshold. If [1m] recognition regresses, the context-fetcher
      // capacity-mismatch warning surfaces it. We must NOT enable NeoKai
      // fallback here — it would fire at 850k (reserveBasedThreshold(1M)) and
      // preempt the SDK's correct ~987k trigger, cutting off 137k of the
      // advertised 1M context.
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

    it('should disable SDK auto-compaction when context window is unavailable', () => {
      expect(buildProviderSettings('openrouter')).toEqual({
        autoCompactEnabled: false,
      });
    });

    it('should disable SDK auto-compaction for Kimi (PP() caps at 200k, NeoKai fallback instead)', () => {
      // The SDK's PP() returns 200k for 'kimi-for-coding'. Even with the
      // autoCompactWindow setting, the SDK's effective window would be
      // min(200k, 262k) = 200k, firing compaction at ~187k instead of ~249k.
      // We disable SDK auto-compact entirely and let NeoKai's fallback
      // (sdk-message-handler) trigger compaction at the correct threshold.
      expect(buildProviderSettings('kimi')).toEqual({
        autoCompactEnabled: false,
      });
      expect(buildProviderSettings('kimi', 262_144)).toEqual({
        autoCompactEnabled: false,
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
      });
    });

    it('should disable SDK auto-compaction for OpenRouter when model is unknown', async () => {
      registerOpenRouterProvider();
      // Empty cache — model not found
      setModelsCache(new Map());
      mockSession.config.provider = 'openrouter';
      mockSession.config.model = 'unknown-model';
      const options = await builder.build();
      expect(options.settings).toEqual({
        autoCompactEnabled: false,
      });
    });

    it('should leave settings undefined for native anthropic provider', async () => {
      // Default mockSession uses anthropic provider
      const options = await builder.build();
      expect(options.settings).toBeUndefined();
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

      // Default provider (anthropic) supports thinking — 'off' must emit explicit disable
      expect(result.thinking).toEqual({ type: 'disabled' });
    });

    it('should omit thinking config for providers with thinkingModes=off', async () => {
      mockSession.config.provider = 'minimax';
      mockSession.config.thinkingLevel = 'think32k';
      // Pass minimal options directly — avoid build() because it instantiates
      // the provider context and MiniMax lacks an API key in CI.
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toBeUndefined();
    });

    it('should preserve selected budget for providers with thinkingModes=on', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.thinkingLevel = 'think8k';
      // Pass minimal options directly — avoid build() because it instantiates
      // the provider context and Kimi lacks an API key in CI.
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    });

    it('should explicitly disable thinking for kimi when level is off', async () => {
      mockSession.config.provider = 'kimi';
      mockSession.config.thinkingLevel = 'off';
      const result = builder.addSessionStateOptions(
        {} as import('@anthropic-ai/claude-agent-sdk').Options
      );

      expect(result.thinking).toEqual({ type: 'disabled' });
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
      // Custom-endpoint scenario: the provider exposes one thinking model
      // and one non-thinking model. Provider aggregate says `on`, but the
      // selected model is the non-thinking one — the builder must skip
      // emitting any thinking payload. This is critical for the
      // anthropic-messages pass-through bridge because it forwards body
      // bytes verbatim and a `thinking` field would 4xx upstream.
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
      // In M5 the SDK is locked to `strictMcpConfig: true` +
      // `settingSources: []`, so it will not auto-load `.mcp.json` —
      // `mcpServers` simply stays undefined when no skill/registry entry
      // contributes one.
      expect(options.mcpServers).toBeUndefined();
    });
  });

  describe('setting sources configuration', () => {
    // Post-M5: `settingSources` defaults to the global settings value
    // (['user', 'project', 'local']) so CLAUDE.md and user/project settings are
    // loaded.  MCP remains locked to `strictMcpConfig: true` (unified
    // `app_mcp_servers` registry only) regardless of settingSources.
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
      // Worker sessions (type: 'worker') must not be affected by space_chat restrictions
      mockSession.type = 'worker';
      const options = await builder.build();
      // Worker sessions still pass through `strictMcpConfig: true` (set
      // unconditionally in M5); `tools` is undefined because no preset
      // or per-room override imposes a restriction.
      expect(options.strictMcpConfig).toBe(true);
      expect(options.tools).toBeUndefined();
    });
  });

  // ============================================================================
  // M5 (unify-mcp-config-model): strictMcpConfig is forced unconditionally;
  // settingSources defaults to global settings (['user', 'project', 'local']) but can be
  // overridden per-session. The M1 `NEOKAI_LEGACY_MCP_AUTOLOAD` kill switch was
  // removed. These tests pin the post-M5 contract per session type so any
  // regression that re-introduces auto-loading is caught.
  // ============================================================================
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
      // Pre-M1 behavior was for the SDK to auto-load any `.mcp.json` at the
      // workspace root because `settingSources` defaulted to `['project', 'local']`.
      // Post-M5 the SDK still respects settingSources for *settings* files, but
      // `strictMcpConfig: true` blocks `.mcp.json` auto-loading regardless.
      // An ad-hoc worker session with no programmatic mcpServers emits an
      // `undefined` mcpServers option — i.e. nothing to inject.
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

    it('ignores NEOKAI_LEGACY_MCP_AUTOLOAD — the M1 kill switch was removed in M5', async () => {
      // Setting the legacy env var must have no effect; settingSources stays
      // at the global default and strictMcpConfig stays true regardless of
      // value or session type.
      const previous = process.env.NEOKAI_LEGACY_MCP_AUTOLOAD;
      try {
        for (const val of ['1', 'true', 'yes']) {
          process.env.NEOKAI_LEGACY_MCP_AUTOLOAD = val;
          mockSession.type = 'worker';
          const options = await builder.build();
          expect(options.strictMcpConfig).toBe(true);
          expect(options.settingSources).toEqual(['user', 'project', 'local']);
        }
      } finally {
        if (previous === undefined) {
          delete process.env.NEOKAI_LEGACY_MCP_AUTOLOAD;
        } else {
          process.env.NEOKAI_LEGACY_MCP_AUTOLOAD = previous;
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

      // Should include home directories for settings/storage and temp directories for shell operations
      expect(options.additionalDirectories).toEqual([
        homedir() + '/.claude',
        homedir() + '/.neokai',
        '/tmp',
        '/tmp/claude',
        expect.stringContaining('/tmp/zsh-'),
      ]);
    });

    it('should include home directories when no worktree', async () => {
      const options = await builder.build();
      expect(options.additionalDirectories).toEqual([
        homedir() + '/.claude',
        homedir() + '/.neokai',
      ]);
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

    it('should default to bypassPermissions', async () => {
      const options = await builder.build();
      expect(options.permissionMode).toBe('bypassPermissions');
    });

    it('should map default to bypassPermissions', async () => {
      mockSession.config.permissionMode = 'default';
      const options = await builder.build();
      expect(options.permissionMode).toBe('bypassPermissions');
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
      // No matcher: the loop detector observes every PreToolUse so that
      // untracked tools (Edit, Write, Bash, …) can serve as the
      // "different action" that breaks a denied streak. Decision logic
      // (which tools to deny, which to merely use as reset signals)
      // lives inside the hook itself.
      expect(options.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
      expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    });

    it('installs paired PostToolUse and PostToolUseFailure observers for the Bash dead-loop detector', async () => {
      const options = await builder.build();

      // The Bash failure-aware detector needs the PostToolUse and
      // PostToolUseFailure events to populate its outcome ring. Without
      // these the Bash deny path is permanently disabled.
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
        'gh pr \\\nmerge 123', // line continuation
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

      // Both guards share the same matcher, so they should be under one entry.
      // (The loop-detector matcher is also present at a different index.)
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
            pattern: '[invalid(', // unmatched paren — invalid regex
            decision: 'deny' as const,
            reason: 'Bad pattern',
          },
        ],
      });
      const options = await guardBuilder.build();

      // Hook is compiled (no crash), but the no-op callback returns {}
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
      // agents should not contain coordinator specialists
      if (options.agents) {
        const agentNames = Object.keys(options.agents);
        expect(agentNames).not.toContain('Coordinator');
      }
    });

    it('should NOT set coordinator agent when coordinatorMode is undefined', async () => {
      // coordinatorMode not set - defaults to falsy
      const options = await builder.build();

      expect(options.agent).toBeUndefined();
    });

    it('should transition from non-coordinator to coordinator options (OFF -> ON)', async () => {
      // Build with coordinator OFF
      mockSession.config.coordinatorMode = false;
      const optionsOff = await builder.build();
      expect(optionsOff.agent).toBeUndefined();

      // Build with coordinator ON (simulating config update + query restart)
      mockSession.config.coordinatorMode = true;
      const builderOn = new QueryOptionsBuilder(mockContext);
      const optionsOn = await builderOn.build();
      expect(optionsOn.agent).toBe('Coordinator');
      expect(Object.keys(optionsOn.agents!)).toHaveLength(7);
    });

    it('should transition ON -> OFF -> ON correctly', async () => {
      // ON
      mockSession.config.coordinatorMode = true;
      let options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.agent).toBe('Coordinator');

      // OFF
      mockSession.config.coordinatorMode = false;
      options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.agent).toBeUndefined();

      // ON again
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

      // Coordinator should NOT have worktree text
      const coordinatorPrompt = (options.agents!['Coordinator'] as { prompt: string }).prompt;
      expect(coordinatorPrompt).not.toContain('Git Worktree Isolation');

      // Specialists should have worktree text
      const coderPrompt = (options.agents!['Coder'] as { prompt: string }).prompt;
      expect(coderPrompt).toContain('Git Worktree Isolation');
    });

    it('should NOT restrict session-level tools in coordinator mode (sub-agents need full tool access)', async () => {
      mockSession.config.coordinatorMode = true;
      const options = await builder.build();

      // Session-level tools must NOT be restricted to coordinator's tools.
      // Options.tools is the BASE set for the entire session including sub-agents.
      // If restricted to ['Task', 'TodoWrite', 'AskUserQuestion'], sub-agents like
      // Coder (tools: ['Read', 'Edit', 'Write', ...]) get an empty tool set
      // because AgentDefinition.tools is a filter on the base set.
      expect(options.tools).not.toEqual(['Task', 'TodoWrite', 'AskUserQuestion']);
    });

    it('should preserve sdkToolsPreset in coordinator mode', async () => {
      mockSession.config.coordinatorMode = true;
      mockSession.config.sdkToolsPreset = { type: 'preset', preset: 'claude_code' };
      const options = await builder.build();

      // Coordinator mode should NOT override the preset - sub-agents need full tools
      expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('should set allowedTools for all tools in coordinator mode', async () => {
      mockSession.config.coordinatorMode = true;
      const options = await builder.build();

      // allowedTools ensures sub-agents can use tools under dontAsk permission mode
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

      // canUseTool should not be set by coordinator mode
      // (only set if explicitly via setCanUseTool for AskUserQuestion handler)
      expect(options.canUseTool).toBeUndefined();
    });

    it('should preserve existing canUseTool when coordinatorMode is on', async () => {
      mockSession.config.coordinatorMode = true;

      // Set an existing canUseTool callback (like AskUserQuestion handler)
      const originalCallback = async () => {
        return { behavior: 'allow' as const };
      };
      builder.setCanUseTool(originalCallback);
      const options = await builder.build();

      // The original callback should be passed through unchanged
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
        // Default provider is anthropic; no registry setup needed.
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
      // Verify the option is included in the final options object
      // (Debug logging will show this value automatically)
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
      // getEnabledSkills() only returns enabled skills — simulate that
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

      // Only the enabled plugin skill should appear
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
        // Skill itself is enabled (getEnabledSkills returns it)
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

      // Disabled AppMcpServer must not be injected even though the skill is enabled
      expect(options.mcpServers).toBeUndefined();
    });

    it('should skip MCP server skills when referenced app_mcp_servers entry is deleted', async () => {
      const mockAppMcpServerRepo = {
        get: mock(() => null), // Simulates deleted entry
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

      // MCP server skill should be silently skipped
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

      // strictMcpConfig should be true for space_chat
      expect(options.strictMcpConfig).toBe(true);
      // Skill-injected server must be present in mcpServers so strictMcpConfig doesn't block it
      expect(options.mcpServers!['test-search']).toEqual({
        command: 'npx',
        args: ['-y', 'test-mcp'],
        env: { TEST_API_KEY: 'test-key' },
      });
      // Original space server must still be present
      expect(options.mcpServers!['space-agent-tools']).toEqual({ command: 'space-cmd' });
      // Skill MCP server wildcard should be auto-allowed
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

      // Builtin skills are injected as local plugins so the SDK discovers their SKILL.md.
      // The path must point at the *wrapper* plugin directory
      // (~/.neokai/skill-plugins/<commandName>), not the raw skill directory
      // (~/.neokai/skills/<commandName>), because only the wrapper has the
      // .claude-plugin/plugin.json manifest the SDK requires — otherwise the
      // SDK silently drops the plugin entry and `/<commandName>` never registers.
      expect(options.plugins).toBeDefined();
      expect(options.plugins).toHaveLength(1);
      expect(options.plugins![0]).toMatchObject({ type: 'local' });
      const pluginPath = (options.plugins![0] as { type: string; path: string }).path;
      expect(pluginPath).toContain('.neokai/skill-plugins/playwright');
      // Must NOT point at the raw skill directory — that path lacks the plugin manifest.
      expect(pluginPath).not.toMatch(/\.neokai\/skills\/playwright(?:$|\/)/);
      // Builtin skills do not contribute to mcpServers
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
      expect(pluginPath).toContain('.neokai/skill-plugins/space-coordination');
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
        // getEnabledSkills returns only enabled skills — disabled are not returned
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

      // Disabled skill should not appear in plugins
      void builtinSkill; // referenced to avoid lint warning
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

    // ------------------------------------------------------------------
    // MCP M6: per-session `mcp_enablement` overrides must filter the
    // skill bridge too, not just the spawn path's direct `config.mcpServers`
    // injection. Without this wiring a user disabling a skill-wrapped MCP
    // server via the Tools modal would see the toggle persist but the
    // server would still be injected (because the skill bridge bypasses
    // config.mcpServers).
    // ------------------------------------------------------------------
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

        // Skill-wrapped server must not be injected despite the skill itself
        // and the registry row both being enabled.
        expect(options.mcpServers?.['test-search']).toBeUndefined();
      });

      it('includes the server when the session override explicitly enables a globally-disabled registry row', async () => {
        // Start from a disabled registry row so we can verify the session
        // override can override-in (not just override-out).
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
        const mockSkillsManager = { getEnabledSkills: mock(() => [mcpSkill]) };
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
      });

      it('honours the session > room > space > registry precedence chain', async () => {
        // room disables; session does NOT override — server must be hidden.
        mockSession.context = { roomId: 'room-1', spaceId: 'space-1' };
        const ctxRoomDisables = buildContext([
          { scopeType: 'room', scopeId: 'room-1', serverId: 'mcp-server-uuid', enabled: false },
        ]);
        const builder1 = new QueryOptionsBuilder(ctxRoomDisables);
        const options1 = await builder1.build();
        expect(options1.mcpServers?.['test-search']).toBeUndefined();

        // Same room-level disable, but now a session-scope override re-enables —
        // more specific scope wins.
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
        // No mcpEnablementRepo — pre-M6 behaviour preserved: registry row's
        // enabled flag is the only signal.
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

      // Skill override disables the skill — must not appear in plugins
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

      // Skill override disables the MCP skill — must not appear in mcpServers
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
        // Disable only pluginSkill; anotherPlugin should still appear
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

  // Session-scoped skill disable list (task #122).
  //
  // `ToolsConfig.disabledSkills` lets the session Tools modal opt out of
  // individual skills without mutating the global registry. The filter is
  // additive on top of explicit skill overrides — see `getSessionDisabledSkillIds()` in
  // `query-options-builder.ts` — and applies to both plugin and mcp_server
  // skills, so the SDK build never sees the disabled entries.
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

      // Session disable wins — plugin must not be injected.
      expect(options.plugins).toBeUndefined();
    });

    it('excludes a builtin skill listed in tools.disabledSkills', async () => {
      // Regression guard: `buildPluginsFromBuiltinSkills` must honour the
      // session disable list the same way the plugin and mcp_server paths do.
      // Without this filter, a session-disabled builtin would still show up
      // as a `/<commandName>` slash command for that session.
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

      // Builtin skill is filtered — no plugin entry materialises for it.
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

      // Skill bridge respects the session disable — no entry in mcpServers.
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

      // `pluginSkill` is filtered, `otherPlugin` survives — proves the filter
      // is keyed by skill ID rather than wiping the whole list.
      expect(options.plugins).toEqual([{ type: 'local', path: '/plugins/other-session-plugin' }]);
    });

    it('is additive with skill overrides (explicit disable wins even when session list is empty)', async () => {
      // Regression guard: a session with `disabledSkills: []` must still
      // honour an explicit skill override that says enabled=false. The two scopes
      // are independent disable lists.
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
      // Default for legacy sessions — must not regress the existing
      // "all enabled skills are injected" behaviour.
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

  // Task 7.1 regression: Skill/WebSearch/WebFetch tools must remain available after Skills registry changes
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
      const options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.allowedTools).toContain('WebSearch');
      expect(options.allowedTools).toContain('WebFetch');
    });

    it('coordinator mode allowedTools includes Skill, WebSearch, WebFetch', async () => {
      mockSession.config.coordinatorMode = true;
      const options = await new QueryOptionsBuilder(mockContext).build();
      expect(options.allowedTools).toContain('Skill');
      expect(options.allowedTools).toContain('WebSearch');
      expect(options.allowedTools).toContain('WebFetch');
    });
  });

  // NOTE: Per-session `disabledMcpServers` filtering was removed in M5
  // (unify-mcp-config-model). MCP enablement now flows through the unified
  // `app_mcp_servers` registry plus per-room/per-session `mcp_enablement`
  // overrides — `QueryOptionsBuilder` no longer trims `mcpServers` based on
  // a per-session list. Tests for the legacy filter are gone.

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
      // coordinatorMode is never set — the always-on pattern default
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
      // Even if room agent config is set, coordinator mode takes over
      mockSession.config.agent = 'Coder';
      mockSession.config.agents = {
        Coder: coderAgentDef,
        'coder-explorer': coderExplorerDef,
      };
      mockSession.config.coordinatorMode = true;

      const options = await builder.build();

      // Coordinator mode overwrites agent to 'Coordinator'
      expect(options.agent).toBe('Coordinator');
      // Coordinator specialists are present
      expect(options.agents!['Coordinator']).toBeDefined();
      expect(options.agents!['Debugger']).toBeDefined();
      // The coordinator's Coder specialist wins over the room-agent Coder def
      expect(options.agents!['Coder']).toBeDefined();
    });

    it('coordinatorMode ON merges room custom agents into coordinator agents map', async () => {
      // Custom non-conflicting agents from room config are preserved in coordinator mode
      mockSession.config.agents = {
        'my-custom': { description: 'Custom agent', prompt: 'Custom.' },
      };
      mockSession.config.coordinatorMode = true;

      const options = await builder.build();

      expect(options.agent).toBe('Coordinator');
      // Custom agent is merged in (no name conflict with specialist names)
      expect(options.agents!['my-custom']).toBeDefined();
      // Built-in specialists are also present
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
      // coordinatorMode is off (room agent mode)
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

      // System prompt gets worktree isolation (session-level protection)
      const systemPrompt = options.systemPrompt as { append?: string };
      expect(systemPrompt.append).toContain('Git Worktree Isolation');

      // Sub-agent prompts are NOT modified — cwd is the worktree path,
      // which provides the actual directory isolation for sub-agents
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

      // Coordinator mode injects worktree isolation into specialist agents
      const coderPrompt = (options.agents!['Coder'] as { prompt: string }).prompt;
      expect(coderPrompt).toContain('Git Worktree Isolation');

      // But NOT into the Coordinator itself
      const coordinatorPrompt = (options.agents!['Coordinator'] as { prompt: string }).prompt;
      expect(coordinatorPrompt).not.toContain('Git Worktree Isolation');
    });
  });
});
