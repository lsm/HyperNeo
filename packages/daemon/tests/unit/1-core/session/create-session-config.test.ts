import { beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('@hyperneo/shared/sdk/type-guards', () => ({
  isSDKAssistantMessage: (msg: { type: string }) => msg.type === 'assistant',
  isSDKUserMessage: (msg: { type: string }) => msg.type === 'user',
  isSDKUserMessageReplay: () => false,
  isSDKResultMessage: (msg: { type: string }) => msg.type === 'result',
  isSDKResultSuccess: (msg: { type: string; subtype?: string }) =>
    msg.type === 'result' && msg.subtype === 'success',
  isSDKResultError: (msg: { type: string; subtype?: string }) =>
    msg.type === 'result' && msg.subtype !== 'success',
  isSDKSystemMessage: (msg: { type: string }) => msg.type === 'system',
  isSDKSystemInit: (msg: { type: string; subtype?: string }) =>
    msg.type === 'system' && msg.subtype === 'init',
  isSDKCompactBoundary: () => false,
  isSDKStatusMessage: () => false,
  isSDKModelRefusalFallbackMessage: () => false,
  isSDKSessionStateChangedMessage: () => false,
  isSDKCommandsChangedMessage: () => false,
  isSDKThinkingTokensMessage: () => false,
  flattenSDKSlashCommands: () => [],
  isSDKHookResponse: () => false,
  isSDKAPIRetryMessage: () => false,
  isSDKStreamEvent: (msg: { type: string }) => msg.type === 'stream_event',
  isSDKToolProgressMessage: () => false,
  isSDKAuthStatusMessage: () => false,
  isSDKRateLimitEvent: () => false,
  isToolUseBlock: (block: { type: string }) => block.type === 'tool_use',
  isTextBlock: (block: { type: string }) => block.type === 'text',
  isThinkingBlock: (block: { type: string }) => block.type === 'thinking',
  isUserVisibleMessage: () => true,
}));

mock.module('../../../../src/lib/provider-service', () => ({
  getProviderService: () => ({
    getDefaultProvider: async () => 'anthropic',
    getProviderApiKey: () => undefined,
    isProviderAvailable: async () => false,
    mergeProviderEnvVars: (s: object) => s,
    applyEnvVarsToProcessForProvider: () => ({}),
    getTitleGenerationConfig: async () => ({ modelId: 'claude-sonnet-4-20250514' }),
    getTitleGenerationModels: async (_p: string, sessionModelId: string) => ({
      providerModelId: sessionModelId,
      sdkModelId: sessionModelId,
    }),
    getEnvVarsForModel: () => ({}),
    restoreEnvVars: () => {},
  }),
  mergeProviderEnvVars: (s: object) => s,
}));

import type { MessageHub, Session, SessionConfig } from '@hyperneo/shared';
import {
  admitCreateSessionConfig,
  CREATE_SESSION_CONFIG_FIELD_POLICY,
  UnsupportedSessionConfigFieldsError,
} from '../../../../src/lib/session/create-session-config';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { AgentSessionFactory, SessionCache } from '../../../../src/lib/session/session-cache';
import {
  SessionLifecycle,
  type SessionLifecycleConfig,
} from '../../../../src/lib/session/session-lifecycle';
import type { ToolsConfigManager } from '../../../../src/lib/session/tools-config';
import type { WorktreeManager } from '../../../../src/lib/worktree-manager';
import type { Database } from '../../../../src/storage/database';

describe('admitCreateSessionConfig', () => {
  it('carries every SDK tool-restriction field the caller supplied', () => {
    const admitted = admitCreateSessionConfig({
      disallowedTools: ['Bash', 'Write'],
      allowedTools: ['Read'],
      sdkToolsPreset: ['Read', 'Glob'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'be careful' },
      agent: 'restricted',
      agents: {
        restricted: { description: 'd', prompt: 'p', disallowedTools: ['Bash'] },
      },
      features: { rewind: false },
    });

    expect(admitted.disallowedTools).toEqual(['Bash', 'Write']);
    expect(admitted.allowedTools).toEqual(['Read']);
    expect(admitted.sdkToolsPreset).toEqual(['Read', 'Glob']);
    expect(admitted.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'be careful',
    });
    expect(admitted.agent).toBe('restricted');
    expect(admitted.agents?.restricted?.disallowedTools).toEqual(['Bash']);
    expect(admitted.features).toEqual({ rewind: false });
  });

  it('leaves derived fields to the lifecycle instead of carrying them', () => {
    const admitted = admitCreateSessionConfig({
      model: 'opus',
      provider: 'anthropic',
      maxTokens: 123,
      disallowedTools: ['Bash'],
    });

    expect(admitted).not.toHaveProperty('model');
    expect(admitted).not.toHaveProperty('provider');
    expect(admitted).not.toHaveProperty('maxTokens');
    expect(admitted.disallowedTools).toEqual(['Bash']);
  });

  it('rejects host process control fields instead of dropping them', () => {
    expect(() =>
      admitCreateSessionConfig({ pathToClaudeCodeExecutable: '/tmp/evil' })
    ).toThrowError(UnsupportedSessionConfigFieldsError);
    expect(() => admitCreateSessionConfig({ env: { PATH: '/tmp' } })).toThrowError(
      /does not accept config field\(s\): env/
    );
    expect(() =>
      admitCreateSessionConfig({ plugins: [{ type: 'local', path: '/tmp/p' }] })
    ).toThrowError(/plugins/);
  });

  it('ignores rejected keys that are present but undefined', () => {
    expect(() => admitCreateSessionConfig({ env: undefined, cwd: undefined })).not.toThrow();
  });

  it('carries every field classified as carried and refuses every field classified as rejected', () => {
    const entries = Object.entries(CREATE_SESSION_CONFIG_FIELD_POLICY);
    const carried = entries.filter(([, policy]) => policy === 'carried').map(([field]) => field);
    const rejected = entries.filter(([, policy]) => policy === 'rejected').map(([field]) => field);
    expect(carried.length).toBeGreaterThan(0);
    expect(rejected).toContain('pathToClaudeCodeExecutable');

    const sentinels: Record<string, unknown> = {};
    for (const field of carried) sentinels[field] = `sentinel:${field}`;
    const admitted = admitCreateSessionConfig(sentinels as Partial<SessionConfig>) as Record<
      string,
      unknown
    >;
    for (const field of carried) {
      expect(admitted[field]).toBe(`sentinel:${field}`);
    }

    for (const field of rejected) {
      expect(() =>
        admitCreateSessionConfig({ [field]: 'nope' } as Partial<SessionConfig>)
      ).toThrowError(new RegExp(field));
    }
  });
});

describe('SessionLifecycle.create', () => {
  let lifecycle: SessionLifecycle;
  let createdSessions: Session[];
  let mockDb: Database;

  beforeEach(() => {
    createdSessions = [];
    mockDb = {
      createSession: mock((session: Session) => {
        createdSessions.push(session);
      }),
      updateSession: mock(() => {}),
      deleteSession: mock(() => {}),
      getSession: mock(() => null),
      getGlobalSettings: mock(() => ({
        settingSources: ['user'],
        autoScroll: true,
        thinkingLevel: 'off',
        coordinatorMode: false,
        sandbox: { enabled: true },
      })),
    } as unknown as Database;

    const mockWorktreeManager = {
      detectGitSupport: mock(async () => ({ isGitRepo: false, isBare: false })),
      createWorktree: mock(async () => null),
      removeWorktree: mock(async () => {}),
      getCurrentBranch: mock(async () => null),
    } as unknown as WorktreeManager;

    const mockAgentSession = {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => ({ id: 'test-id', metadata: {} })),
    };

    const mockSessionCache = {
      set: mock(() => {}),
      get: mock(() => mockAgentSession),
      has: mock(() => false),
      remove: mock(() => {}),
      clear: mock(() => {}),
    } as unknown as SessionCache;

    const mockInternalEventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(() => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<never>;

    const mockMessageHub = {
      event: mock(async () => {}),
      onRequest: mock(() => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    const config: SessionLifecycleConfig = {
      defaultModel: 'claude-sonnet-4-6',
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
      {} as unknown as ToolsConfigManager,
      mock(() => mockAgentSession) as unknown as AgentSessionFactory
    );
  });

  it('persists disallowedTools supplied by the caller', async () => {
    await lifecycle.create({ config: { disallowedTools: ['Bash', 'Write', 'Edit'] } });

    expect(createdSessions).toHaveLength(1);
    expect(createdSessions[0]!.config.disallowedTools).toEqual(['Bash', 'Write', 'Edit']);
  });

  it('persists the rest of the tool-restriction config supplied by the caller', async () => {
    await lifecycle.create({
      config: {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'stay in scope' },
        sdkToolsPreset: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Bash(git status)'],
        agent: 'scoped',
        agents: { scoped: { description: 'd', prompt: 'p' } },
        features: { rewind: false, worktree: false },
      },
    });

    const stored = createdSessions[0]!.config;
    expect(stored.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'stay in scope',
    });
    expect(stored.sdkToolsPreset).toEqual(['Read', 'Glob', 'Grep']);
    expect(stored.allowedTools).toEqual(['Bash(git status)']);
    expect(stored.agent).toBe('scoped');
    expect(stored.agents).toEqual({ scoped: { description: 'd', prompt: 'p' } });
    expect(stored.features).toEqual({ rewind: false, worktree: false });
  });

  it('still derives model, sandbox and settingSources rather than carrying them blindly', async () => {
    await lifecycle.create({ config: { disallowedTools: ['Bash'] } });

    const stored = createdSessions[0]!.config;
    expect(stored.model).toBe('claude-sonnet-4-6');
    expect(stored.maxTokens).toBe(8192);
    expect(stored.sandbox).toEqual({ enabled: true });
    expect(stored.settingSources).toEqual(['user']);
  });

  it('refuses a host process control field and creates no session', async () => {
    await expect(
      lifecycle.create({ config: { pathToClaudeCodeExecutable: '/tmp/evil' } })
    ).rejects.toThrow(/pathToClaudeCodeExecutable/);
    expect(createdSessions).toEqual([]);
  });
});
