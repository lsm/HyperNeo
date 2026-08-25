import { KimiProvider } from '../providers/kimi-provider.js';
import { getDataDir } from '../data-dir.ts';
import type {
  CanUseTool,
  HookCallback,
  Options,
  PreToolUseHookInput,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentDefinition,
  AppMcpServer,
  AppMcpServerSourceType,
  ClaudeCodePreset,
  DeclarativeToolGuard,
  Session,
  SkillEnablementOverride,
  SystemPromptConfig,
  ThinkingConfig,
  ThinkingLevel,
  ValidationResult,
} from '@hyperneo/shared';
import {
  isMcpServerSkillConfig,
  normalizeThinkingLevel,
  PROVIDER_THINKING_MODES,
  THINKING_LEVEL_TOKENS,
} from '@hyperneo/shared';
import type { McpServerConfig } from '@hyperneo/shared/types/sdk-config';
import { NON_DELEGATING_GENERAL_AGENT } from '../space/agents/custom-agent.ts';
import type { PermissionMode } from '@hyperneo/shared/types/settings';
import { homedir } from 'os';
import { join } from 'path';
import type { Database } from '../../storage/database.ts';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository.ts';
import type { McpEnablementRepository } from '../../storage/repositories/mcp-enablement-repository.ts';
import { resolveMcpServers, scopeChainForSession } from '../mcp/resolve-mcp-servers.ts';
import { Logger } from '../logger.ts';
import { decideFallbackModelCuration } from './fallback-model-curation.ts';
import {
  getProviderCatalogEpoch,
  getSessionModelInfo,
  isCuratedOutModel,
} from '../model-service.ts';
import {
  getProviderContextManager,
  getProviderRegistry,
  initializeProviders,
  waitForOptionalProviderRegistration,
} from '../providers/factory.js';
import { NON_ANTHROPIC_PREFIX_PROVIDER_VARS } from '../provider-service.ts';
import { buildSdkRuntimeEnv, envValue, STARTUP_ENV_BASELINE } from '../spawn-env.ts';
import type { SettingsManager } from '../settings-manager.ts';
import type { SkillsManager } from '../skills-manager.ts';
import {
  builtinSkillPluginPath,
  defaultBuiltinSkillPluginRoot,
} from './builtin-skill-plugin-wrapper.ts';
import { getCoordinatorAgents } from './coordinator-agents.ts';
import { createLoopDetectorHooks } from './loop-detector-hook.ts';
import { isMessageDeliveryV2Enabled } from './message-delivery.ts';
import { withSdkTranscriptRetention } from './sdk-transcript-retention.ts';
import {
  createOutputLimiterPostHook,
  createOutputLimiterPreHook,
  resolveConfig,
} from './output-limiter-hook.ts';
import { isRunningUnderBun, resolveSDKCliPath } from './sdk-cli-resolver.js';
import { createBashScopeHook, extractBashScopePrefixes } from './bash-scope.ts';

const log = new Logger('QueryOptionsBuilder');

function compileToolGuard(guard: DeclarativeToolGuard): HookCallback {
  let pattern: RegExp;
  try {
    pattern = new RegExp(guard.pattern);
  } catch (err) {
    log.warn(
      `Ignoring invalid declarative tool guard pattern ${JSON.stringify(guard.pattern)}: ${err instanceof Error ? err.message : String(err)}`
    );
    return async () => ({});
  }
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const preInput = input as PreToolUseHookInput;

    const command = (preInput.tool_input as Record<string, unknown>)?.command;
    if (typeof command !== 'string') return {};
    if (!pattern.test(command)) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: guard.decision,
        permissionDecisionReason: guard.reason,
      },
    };
  };
}

const FULL_BUILTIN_TOOL_LIST = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'NotebookEdit',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'ToolSearch',
  'Projects',
  'REPL',
  'Workflow',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'ShowOnboardingRolePicker',
  'Monitor',
  'Artifact',
  'PushNotification',
  'EnterWorktree',
  'ExitWorktree',
];

const AGENT_INVOCATION_TOOLS = ['Agent', 'Task', 'TaskOutput', 'TaskStop'];

function isNonDelegatingGeneralOverride(agents: Options['agents']): boolean {
  if (!agents || Object.keys(agents).length !== 1) return false;
  const agent = agents['general-purpose'];
  return (
    agent?.prompt === NON_DELEGATING_GENERAL_AGENT.prompt &&
    JSON.stringify(agent.tools) === JSON.stringify(NON_DELEGATING_GENERAL_AGENT.tools) &&
    JSON.stringify(agent.disallowedTools) ===
      JSON.stringify(NON_DELEGATING_GENERAL_AGENT.disallowedTools)
  );
}

const NATIVE_AGENT_TOOL_PROVIDERS = ['anthropic', 'anthropic-copilot'];

export function ensureAgentTools(
  tools: Options['tools'],
  agents: Options['agents'],
  providerId: string,
  sessionType: string
): Options['tools'] {
  const hasAgentsConfigured = agents && Object.keys(agents).length > 0;
  if (!hasAgentsConfigured || sessionType === 'space_chat') {
    return tools;
  }

  const onlyOverridesGeneralPurpose =
    sessionType === 'worker' && isNonDelegatingGeneralOverride(agents);
  if (onlyOverridesGeneralPurpose) {
    return tools;
  }

  if (Array.isArray(tools)) {
    if (NATIVE_AGENT_TOOL_PROVIDERS.includes(providerId)) {
      return tools;
    }
    const missing = AGENT_INVOCATION_TOOLS.filter((t) => !(tools as string[]).includes(t));
    if (missing.length > 0) {
      return [...(tools as string[]), ...missing];
    }
    return tools;
  }

  if (!tools && !NATIVE_AGENT_TOOL_PROVIDERS.includes(providerId)) {
    return [...FULL_BUILTIN_TOOL_LIST];
  }

  return tools;
}

export const NATIVE_CONTEXT_WINDOW_PROVIDER_IDS = [
  'anthropic',
  'anthropic-copilot',
  'anthropic-codex',
  'glm',
];

export const PROVIDER_NO_SDK_AUTO_COMPACT: ReadonlySet<string> = new Set();

export function shouldUseHyperNeoCompactFallback(providerId: string): boolean {
  return PROVIDER_NO_SDK_AUTO_COMPACT.has(providerId);
}

export function buildProviderSettings(
  providerId: string,
  contextWindow?: number | null,
  modelId?: string | null
): Settings | undefined {
  if (NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(providerId)) {
    return undefined;
  }

  if (providerId === 'kimi' && modelId && KimiProvider.isKimiK3Model(modelId)) {
    return {
      autoCompactEnabled: true,
      autoCompactWindow: KimiProvider.resolveContextWindow(modelId),
    };
  }

  if (shouldUseHyperNeoCompactFallback(providerId)) {
    return { autoCompactEnabled: false };
  }

  const autoCompactWindow = contextWindow;
  if (!autoCompactWindow) {
    return undefined;
  }

  return {
    autoCompactEnabled: true,
    autoCompactWindow,
  };
}

export interface QueryOptionsBuilderContext {
  readonly session: Session;
  readonly settingsManager: SettingsManager;
  readonly db?: Database;
  consumePendingResumeSessionAt?(): string | undefined;
  peekPendingResumeSessionAt?(): string | undefined;
  readonly skillsManager?: SkillsManager;
  readonly appMcpServerRepo?: AppMcpServerRepository;
  readonly mcpEnablementRepo?: McpEnablementRepository;
  readonly skillOverrides?: SkillEnablementOverride[];
  readonly toolGuards?: DeclarativeToolGuard[];
}

export interface BuiltFallbackIdentity {
  providerId: string;
  primaryModel: string | undefined;
  fallbackModel: string | undefined;
  scopedApiKey?: string;
  scopedBaseUrl?: string;
  scopedRegion?: string;
  providerEpoch?: number;
}

const builtFallbackBySession = new WeakMap<object, BuiltFallbackIdentity>();

export function markBuiltFallbackIdentity(session: object, identity: BuiltFallbackIdentity): void {
  builtFallbackBySession.set(session, identity);
}

export function getBuiltFallbackIdentity(session: object): BuiltFallbackIdentity | undefined {
  return builtFallbackBySession.get(session);
}

export class QueryOptionsBuilder {
  private canUseTool?: CanUseTool;
  private askUserQuestionHook?: HookCallback;
  private deferredPermissionMode?: PermissionMode;
  private effectiveFallbackCaptured = false;
  private effectiveFallbackModel?: string;
  private readonly logger = new Logger('QueryOptionsBuilder');

  constructor(private ctx: QueryOptionsBuilderContext) {}

  setCanUseTool(callback: CanUseTool): void {
    this.canUseTool = callback;
  }

  setAskUserQuestionHook(hook: HookCallback): void {
    this.askUserQuestionHook = hook;
  }

  getDeferredPermissionMode(): PermissionMode | undefined {
    return this.deferredPermissionMode;
  }

  getCurrentPermissionMode(): PermissionMode {
    return this.getPermissionMode();
  }

  getSkillMcpServers(): Record<string, McpServerConfig> {
    return this.getMcpServersFromSkills();
  }

  getEffectiveMcpServers(): Record<string, McpServerConfig> | undefined {
    return this.computeEffectiveMcpServers();
  }

  private computeEffectiveMcpServers(): Record<string, McpServerConfig> | undefined {
    const registryServers = this.getMcpServersFromRegistry();
    const skillServers = this.getMcpServersFromSkills();
    const runtimeServers = this.getMcpServers() as Record<string, McpServerConfig> | undefined;
    const merged: Record<string, McpServerConfig> = {
      ...registryServers,
      ...skillServers,
      ...runtimeServers,
    };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  async build(overrides?: { askUserQuestionHook?: HookCallback }): Promise<Options> {
    const config = this.ctx.session.config;

    await this.ctx.settingsManager.prepareSDKOptions();

    initializeProviders();
    await waitForOptionalProviderRegistration();

    const contextManager = getProviderContextManager();
    await contextManager.ensureContextReady(this.ctx.session);
    const providerContext = contextManager.createContext(this.ctx.session);
    const providerId = providerContext.provider.id;
    const modelInfo = await getSessionModelInfo(this.ctx.session);
    const sdkModelId = providerContext.getSdkModelId();
    let sdkFallbackModel: string | undefined;
    const providerEpoch = getProviderCatalogEpoch(providerId);
    if (config.fallbackModel) {
      const sessionScopedProvider = Boolean(
        config.providerConfig?.apiKey ||
          config.providerConfig?.baseUrl ||
          config.providerConfig?.region
      );
      const outcome = await decideFallbackModelCuration({
        providerId,
        fallbackModel: config.fallbackModel,
        cacheKey: this.ctx.session.id,
        providerConfig: config.providerConfig ?? {},
        sessionScopedProvider,
        signalAborted: false,
        guardsIntact: () => true,
      });
      if (outcome === 'excluded') {
        this.logger.warn(
          `Ignoring curated-out fallback model '${config.fallbackModel}' for provider '${providerId}'`
        );
      } else if (outcome === 'allowed') {
        const contextManager = getProviderContextManager();
        const fallbackSession = {
          ...this.ctx.session,
          config: { ...this.ctx.session.config, model: config.fallbackModel },
        };
        try {
          await contextManager.ensureContextReady(fallbackSession);
          const fallbackContext = contextManager.createContext(fallbackSession);
          sdkFallbackModel = fallbackContext.getSdkModelId();
        } catch {
          this.logger.warn(
            `Ignoring fallback model '${config.fallbackModel}' rejected by provider '${providerId}'`
          );
        }
      }
    }

    const configuredFallbackModel = sdkFallbackModel ? config.fallbackModel : undefined;
    const configuredPrimaryModel = config.model;
    const configuredScopedApiKey = config.providerConfig?.apiKey;
    const configuredScopedBaseUrl = config.providerConfig?.baseUrl;
    const configuredScopedRegion = config.providerConfig?.region;
    this.effectiveFallbackCaptured = true;
    this.effectiveFallbackModel = configuredFallbackModel;
    markBuiltFallbackIdentity(this.ctx.session, {
      providerId,
      primaryModel: config.model,
      fallbackModel: configuredFallbackModel,
      scopedApiKey: configuredScopedApiKey,
      scopedBaseUrl: configuredScopedBaseUrl,
      scopedRegion:
        typeof config.providerConfig?.region === 'string'
          ? config.providerConfig.region
          : undefined,
      providerEpoch,
    });

    const systemPromptConfig = this.buildSystemPrompt();
    const disallowedTools = this.getDisallowedTools();
    const allowedTools = this.getAllowedTools();
    const additionalDirectories = this.getAdditionalDirectories();
    const hooks = this.buildHooks(overrides?.askUserQuestionHook ?? this.askUserQuestionHook);
    const permissionMode = this.getPermissionMode();
    const pluginsFromSkills = [
      ...this.buildPluginsFromSkills(),
      ...this.buildPluginsFromBuiltinSkills(),
    ];
    const mergedEnv = this.getMergedEnvironmentVars(providerContext.sdkConfig.envVars);
    const sdkCliPath = this.getSDKCliPath();

    const mergedMcpServers = this.computeEffectiveMcpServers();

    const queryOptions: Options = {
      model: sdkModelId,
      fallbackModel: sdkFallbackModel,
      maxTurns: config.maxTurns ?? Infinity,
      maxBudgetUsd: config.maxBudgetUsd,

      spawnClaudeCodeProcess: config.spawnClaudeCodeProcess,

      systemPrompt: systemPromptConfig,

      tools: config.sdkToolsPreset,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,

      agent: config.agent,
      agents: config.agents as Options['agents'],

      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',

      sandbox: config.sandbox as Options['sandbox'],

      mcpServers: mergedMcpServers as Options['mcpServers'],
      strictMcpConfig: true,

      outputFormat: config.outputFormat,

      plugins: this.mergePlugins(config.plugins, pluginsFromSkills),

      betas: config.betas,

      cwd: this.getCwd(),
      additionalDirectories,
      env: mergedEnv,
      executable: config.executable ?? (isRunningUnderBun() ? 'bun' : undefined),
      executableArgs: config.executableArgs,
      pathToClaudeCodeExecutable: sdkCliPath,

      settingSources:
        config.settingSources ?? this.ctx.settingsManager.getGlobalSettings().settingSources,
      settings: withSdkTranscriptRetention(
        buildProviderSettings(providerId, modelInfo?.contextWindow, this.ctx.session.config.model)
      ),

      includePartialMessages: config.includePartialMessages ?? isMessageDeliveryV2Enabled(),

      enableFileCheckpointing: config.enableFileCheckpointing ?? true,

      hooks,

      canUseTool: this.canUseTool,
      onUserDialog: async (request, { signal }) => {
        if (request.dialogKind !== 'refusal_fallback_prompt') return { behavior: 'cancelled' };
        if (!configuredFallbackModel) {
          return { behavior: 'cancelled' };
        }
        const guardsIntact = () => {
          const configNow = this.ctx.session.config;
          return (
            !signal.aborted &&
            getProviderCatalogEpoch(providerId) === providerEpoch &&
            (configNow.provider ?? 'anthropic') === providerId &&
            configNow.fallbackModel === configuredFallbackModel &&
            configNow.model === configuredPrimaryModel &&
            configNow.providerConfig?.apiKey === configuredScopedApiKey &&
            configNow.providerConfig?.baseUrl === configuredScopedBaseUrl &&
            configNow.providerConfig?.region === configuredScopedRegion
          );
        };
        const outcome = await decideFallbackModelCuration({
          providerId,
          fallbackModel: configuredFallbackModel,
          cacheKey: this.ctx.session.id,
          providerConfig: this.ctx.session.config.providerConfig ?? {},
          sessionScopedProvider: Boolean(
            this.ctx.session.config.providerConfig?.apiKey ||
              this.ctx.session.config.providerConfig?.baseUrl ||
              this.ctx.session.config.providerConfig?.region
          ),
          signalAborted: signal.aborted,
          guardsIntact,
        });
        if (outcome !== 'allowed') {
          return { behavior: 'cancelled' };
        }
        return { behavior: 'completed', result: { continue: true } };
      },
      supportedDialogKinds: sdkFallbackModel ? ['refusal_fallback_prompt'] : undefined,
    };

    if (this.ctx.session.type === 'space_chat') {
      const coordinatorToolset = config.sdkToolsPreset;
      const isCoordinatorPreset = Array.isArray(coordinatorToolset);
      const spaceAllowedBuiltinTools = isCoordinatorPreset
        ? (coordinatorToolset as string[])
        : [
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
          ];
      const spaceRestrictedBuiltinTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

      const systemPrompt = queryOptions.systemPrompt;
      if (
        typeof systemPrompt === 'object' &&
        systemPrompt !== null &&
        (systemPrompt as ClaudeCodePreset).type === 'preset' &&
        (systemPrompt as ClaudeCodePreset).preset === 'claude_code'
      ) {
        queryOptions.systemPrompt = undefined;
      }

      queryOptions.tools = spaceAllowedBuiltinTools;

      const mcpServerWildcards = Object.keys(queryOptions.mcpServers ?? {}).map(
        (name) => `${name}__*`
      );
      queryOptions.allowedTools = [
        ...new Set([
          ...(queryOptions.allowedTools ?? []),
          ...spaceAllowedBuiltinTools,
          ...mcpServerWildcards,
        ]),
      ];

      queryOptions.disallowedTools = [
        ...new Set([...(queryOptions.disallowedTools ?? []), ...spaceRestrictedBuiltinTools]),
      ];
    }

    if (config.coordinatorMode) {
      queryOptions.agent = 'Coordinator';
      const agents = getCoordinatorAgents(
        config.agents as Record<string, AgentDefinition> | undefined
      );

      if (this.ctx.session.worktree) {
        const worktreeText = this.getWorktreeIsolationText();
        for (const [name, agent] of Object.entries(agents)) {
          if (name === 'Coordinator') continue;
          agents[name] = {
            ...agent,
            prompt: agent.prompt + '\n\n' + worktreeText,
          };
        }
      }

      queryOptions.agents = agents as Options['agents'];

      const existing = queryOptions.allowedTools ?? [];
      queryOptions.allowedTools = [...new Set([...existing, ...FULL_BUILTIN_TOOL_LIST])];
    }

    queryOptions.tools = ensureAgentTools(
      queryOptions.tools,
      queryOptions.agents,
      providerId,
      this.ctx.session.type ?? 'worker'
    );

    if (permissionMode === 'bypassPermissions') {
      delete queryOptions.permissionMode;
      delete queryOptions.allowedTools;
      this.deferredPermissionMode = 'bypassPermissions';
    } else {
      this.deferredPermissionMode = undefined;
    }

    const cleanedOptions = Object.fromEntries(
      Object.entries(queryOptions).filter(([_, v]) => v !== undefined)
    ) as Options;

    return cleanedOptions;
  }

  private thinkingLevelToThinkingConfig(
    level: ThinkingLevel,
    thinkingModes: 'off' | 'on' | 'granular'
  ): ThinkingConfig | undefined {
    if (thinkingModes === 'off') {
      return undefined;
    }

    const tokens = THINKING_LEVEL_TOKENS[level];

    if (tokens === undefined) {
      return { type: 'disabled' };
    }

    return { type: 'enabled', budgetTokens: tokens };
  }

  addSessionStateOptions(options: Options): Options {
    const result = { ...options } as Options & { thinking?: ThinkingConfig };

    if (this.ctx.session.sdkSessionId) {
      result.resume = this.ctx.session.sdkSessionId;
    }

    const resumeSessionAt = this.ctx.peekPendingResumeSessionAt?.();
    if (resumeSessionAt && result.resume) {
      result.resumeSessionAt = resumeSessionAt;
    }

    const providerId = this.ctx.session.config.provider;
    let thinkingModes: 'off' | 'on' | 'granular' =
      PROVIDER_THINKING_MODES[providerId as keyof typeof PROVIDER_THINKING_MODES] ?? 'granular';
    try {
      if (providerId) {
        const provider = getProviderRegistry().get(providerId);
        const liveMode = provider?.capabilities?.thinkingModes;
        if (liveMode) thinkingModes = liveMode;
        const selectedModel = this.ctx.session.config.model;
        const perModelMode = selectedModel
          ? provider?.getModelThinkingMode?.(selectedModel)
          : undefined;
        if (perModelMode) thinkingModes = perModelMode;
      }
    } catch {}
    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    const thinkingLevel = normalizeThinkingLevel(
      this.ctx.session.config.thinkingLevel ?? globalSettings.thinkingLevel
    );
    let thinkingConfig = this.thinkingLevelToThinkingConfig(thinkingLevel, thinkingModes);

    const selectedModel = this.ctx.session.config.model;
    if (providerId === 'kimi' && selectedModel) {
      if (KimiProvider.isKimiK3Model(selectedModel)) {
        if (thinkingConfig?.type === 'disabled') {
          thinkingConfig = undefined;
        }
      } else if (KimiProvider.isKimiK2Point7Model(selectedModel)) {
        if (!thinkingConfig || thinkingConfig.type === 'disabled') {
          thinkingConfig = {
            type: 'enabled',
            budgetTokens: THINKING_LEVEL_TOKENS['think16k']!,
          };
        }
      }

      const fallbackModel = this.effectiveFallbackCaptured
        ? this.effectiveFallbackModel
        : this.ctx.session.config.fallbackModel;
      if (fallbackModel && !isCuratedOutModel(fallbackModel, providerId)) {
        const primaryIsK3 = KimiProvider.isKimiK3Model(selectedModel);
        const fallbackIsK3 = KimiProvider.isKimiK3Model(fallbackModel);
        const primaryIsK2 = KimiProvider.isKimiK2Point7Model(selectedModel);
        const fallbackIsK2 = KimiProvider.isKimiK2Point7Model(fallbackModel);
        const mixedChain = (primaryIsK3 && fallbackIsK2) || (primaryIsK2 && fallbackIsK3);
        if (mixedChain && (!thinkingConfig || thinkingConfig.type === 'disabled')) {
          thinkingConfig = {
            type: 'enabled',
            budgetTokens: THINKING_LEVEL_TOKENS['think16k']!,
          };
        }
      }
    }

    if (thinkingConfig) {
      result.thinking = thinkingConfig;
    } else {
      delete (result as Record<string, unknown>).thinking;
    }

    return result as Options;
  }

  getEffectiveThinkingLevel(): ThinkingLevel {
    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    return normalizeThinkingLevel(
      this.ctx.session.config.thinkingLevel ?? globalSettings.thinkingLevel
    );
  }

  private getSdkResumeWorkspacePath(): string | undefined {
    return this.ctx.session.sdkOriginPath ?? this.getCwd();
  }

  getCwd(): string | undefined {
    if (this.ctx.session.worktree) {
      return this.ctx.session.worktree.worktreePath;
    }
    return this.ctx.session.workspacePath ?? undefined;
  }

  private buildSystemPrompt(): Options['systemPrompt'] {
    const config = this.ctx.session.config;

    if (config.systemPrompt !== undefined) {
      return this.buildCustomSystemPrompt(config.systemPrompt);
    }

    const legacyToolsConfig = config.tools;
    const useClaudeCodePreset = legacyToolsConfig?.useClaudeCodePreset ?? true;

    if (useClaudeCodePreset) {
      const presetConfig: Options['systemPrompt'] = {
        type: 'preset',
        preset: 'claude_code',
      };

      const append = this.joinSystemPromptAppendParts([
        this.ctx.session.worktree ? this.getWorktreeIsolationText() : undefined,
      ]);
      if (append) {
        presetConfig.append = append;
      }

      return presetConfig;
    }

    if (this.ctx.session.worktree) {
      return this.joinSystemPromptAppendParts([this.getMinimalWorktreePrompt()]);
    }

    return undefined;
  }

  private buildCustomSystemPrompt(systemPrompt: SystemPromptConfig): Options['systemPrompt'] {
    if (typeof systemPrompt === 'string') {
      return this.joinSystemPromptAppendParts([
        systemPrompt,
        this.ctx.session.worktree ? this.getWorktreeIsolationText() : undefined,
      ]);
    }

    if (systemPrompt.type === 'preset' && systemPrompt.preset === 'claude_code') {
      const presetConfig: ClaudeCodePreset = {
        type: 'preset',
        preset: 'claude_code',
      };

      const append = this.joinSystemPromptAppendParts([
        systemPrompt.append,
        this.ctx.session.worktree ? this.getWorktreeIsolationText() : undefined,
      ]);
      if (append) {
        presetConfig.append = append;
      }

      return presetConfig;
    }

    return undefined;
  }

  private joinSystemPromptAppendParts(parts: Array<string | undefined>): string {
    return parts
      .map((part) => part?.trim())
      .filter((part): part is string => !!part)
      .join('\n\n');
  }

  private getWorktreeIsolationText(): string {
    const wt = this.ctx.session.worktree!;
    return `
IMPORTANT: Git Worktree Isolation

Work only inside this isolated worktree:
${wt.worktreePath}

Branch: ${wt.branch}
Main repository (read-only unless post-approval instructions say otherwise): ${wt.mainRepoPath}

Your cwd is already the worktree path. Do not modify files in the main repository.
`.trim();
  }

  private getMinimalWorktreePrompt(): string {
    const wt = this.ctx.session.worktree!;
    return `
You are an AI assistant helping with coding tasks.

IMPORTANT: Git Worktree Isolation

This session is running in an isolated git worktree at:
${wt.worktreePath}

Branch: ${wt.branch}
Main repository: ${wt.mainRepoPath}

CRITICAL RULES:
1. ALL file operations MUST stay within the worktree directory: ${wt.worktreePath}
2. NEVER modify files in the main repository at: ${wt.mainRepoPath}
3. Your current working directory (cwd) is already set to the worktree path
`.trim();
  }

  private getDisallowedTools(): string[] {
    const config = this.ctx.session.config;
    const disallowedTools: string[] = [];

    if (config.disallowedTools && config.disallowedTools.length > 0) {
      disallowedTools.push(...config.disallowedTools);
    }

    return [...new Set(disallowedTools)];
  }

  private getAllowedTools(): string[] {
    const config = this.ctx.session.config;

    if (config.allowedTools && config.allowedTools.length > 0) {
      return [...config.allowedTools];
    }

    return [];
  }

  private getMcpServers(): Record<string, unknown> | undefined {
    const config = this.ctx.session.config;
    if (config.mcpServers !== undefined) {
      return config.mcpServers as Record<string, unknown>;
    }

    return undefined;
  }

  private mergePlugins(
    configPlugins: Options['plugins'],
    skillPlugins: Array<{ type: 'local'; path: string }>
  ): Options['plugins'] {
    if (!configPlugins && skillPlugins.length === 0) return undefined;
    return [...(configPlugins ?? []), ...skillPlugins];
  }

  private getAdditionalDirectories(): string[] | undefined {
    const directories: string[] = [];

    const dataDir = getDataDir();
    directories.push(join(homedir(), '.claude'));
    directories.push(dataDir);

    if (this.ctx.session.worktree) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
      directories.push('/tmp', '/tmp/claude', `/tmp/zsh-${uid}`);
    }

    return directories;
  }

  private getMergedEnvironmentVars(
    sessionProviderEnvVars: Record<string, string> = {}
  ): Record<string, string> | undefined {
    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    const sessionEnv = this.ctx.session.config.env;

    const providerEnvVars = new Set([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'API_TIMEOUT_MS',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    ]);
    providerEnvVars.add('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    const processProviderEnvVars = new Set(providerEnvVars);

    const mergedEnv: Record<string, string> = buildSdkRuntimeEnv();
    for (const key of processProviderEnvVars) {
      delete mergedEnv[key];
    }

    if (this.ctx.session.config.provider === 'anthropic' || !this.ctx.session.config.provider) {
      const authToken = envValue(STARTUP_ENV_BASELINE, 'ANTHROPIC_AUTH_TOKEN');
      if (authToken?.startsWith('sk-ant-oat')) {
        mergedEnv.ANTHROPIC_AUTH_TOKEN = authToken;
      }
      const oauthToken = envValue(STARTUP_ENV_BASELINE, 'CLAUDE_CODE_OAUTH_TOKEN');
      if (oauthToken) {
        mergedEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      }
      const apiKey = envValue(STARTUP_ENV_BASELINE, 'ANTHROPIC_API_KEY');
      if (apiKey) {
        mergedEnv.ANTHROPIC_API_KEY = apiKey;
      }
    } else {
      delete mergedEnv.CLAUDE_CODE_SUBAGENT_MODEL;
      delete mergedEnv.ENABLE_TOOL_SEARCH;
      const providerVars = [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'API_TIMEOUT_MS',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_OAUTH_TOKEN',
      ];
      for (const key of NON_ANTHROPIC_PREFIX_PROVIDER_VARS) {
        const value = sessionProviderEnvVars[key];
        if (value !== undefined && value !== '') {
          mergedEnv[key] = value;
        }
      }
      for (const key of providerVars) {
        const value = envValue(STARTUP_ENV_BASELINE, key);
        if (value !== undefined && value !== '') {
          mergedEnv[key] = value;
        }
      }
    }

    if (globalSettings.env) {
      for (const [key, value] of Object.entries(globalSettings.env)) {
        if (value !== undefined && !providerEnvVars.has(key)) {
          mergedEnv[key] = value;
        }
      }
    }

    if (sessionEnv) {
      for (const [key, value] of Object.entries(sessionEnv)) {
        if (value !== undefined && !providerEnvVars.has(key)) {
          mergedEnv[key] = value;
        }
      }
    }

    return Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;
  }

  private getPermissionMode(): PermissionMode {
    if (this.ctx.session.config.permissionMode) {
      if (this.ctx.session.config.permissionMode === 'default') {
        return 'bypassPermissions';
      }
      return this.ctx.session.config.permissionMode;
    }

    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    if (globalSettings.permissionMode) {
      if (globalSettings.permissionMode === 'default') {
        return 'bypassPermissions';
      }
      return globalSettings.permissionMode;
    }

    return 'bypassPermissions';
  }

  private buildHooks(askUserQuestionHook?: HookCallback): Options['hooks'] {
    const hooks: NonNullable<Options['hooks']> = {};
    const preToolUse: NonNullable<Options['hooks']>['PreToolUse'] = [];

    if (askUserQuestionHook) {
      preToolUse.push({
        matcher: 'AskUserQuestion',
        timeout: 86400,
        hooks: [askUserQuestionHook],
      });
    }

    const loopDetectorHooks = createLoopDetectorHooks();
    preToolUse.push({
      hooks: [loopDetectorHooks.preToolUse],
    });

    const guards = this.ctx.toolGuards;
    if (guards?.length) {
      const byMatcher = new Map<string, DeclarativeToolGuard[]>();
      for (const guard of guards) {
        if (!guard || typeof guard !== 'object' || !guard.matcher) continue;
        const existing = byMatcher.get(guard.matcher) ?? [];
        existing.push(guard);
        byMatcher.set(guard.matcher, existing);
      }

      for (const [matcher, matcherGuards] of byMatcher) {
        preToolUse.push({
          matcher,
          hooks: matcherGuards.map(compileToolGuard),
        });
      }
    }

    const bashScopePrefixes = extractBashScopePrefixes(this.ctx.session.config.allowedTools ?? []);
    if (bashScopePrefixes.length > 0) {
      preToolUse.push({
        matcher: 'Bash',
        hooks: [createBashScopeHook(bashScopePrefixes)],
      });
    }

    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    const outputLimiterSettings = globalSettings.outputLimiter;
    const outputLimiterEnabled =
      outputLimiterSettings && resolveConfig(outputLimiterSettings).enabled;
    if (outputLimiterEnabled) {
      preToolUse.push({
        hooks: [createOutputLimiterPreHook(outputLimiterSettings)],
      });
    }

    if (preToolUse.length > 0) {
      hooks.PreToolUse = preToolUse;
    }

    const postHooks: NonNullable<Options['hooks']>['PostToolUse'] = [
      { hooks: [loopDetectorHooks.postToolUse] },
    ];
    if (outputLimiterEnabled) {
      postHooks.push({ hooks: [createOutputLimiterPostHook(outputLimiterSettings)] });
    }
    hooks.PostToolUse = postHooks;

    hooks.PostToolUseFailure = [{ hooks: [loopDetectorHooks.postToolUseFailure] }];
    return hooks;
  }

  private getSDKCliPath(): string | undefined {
    const config = this.ctx.session.config;

    if (config.pathToClaudeCodeExecutable) {
      return config.pathToClaudeCodeExecutable;
    }

    const resolvedPath = resolveSDKCliPath();
    if (resolvedPath) {
      return resolvedPath;
    }

    return undefined;
  }

  private getOverrideDisabledSkillIds(): Set<string> {
    if (!this.ctx.skillOverrides?.length) return new Set();
    return new Set(this.ctx.skillOverrides.filter((o) => !o.enabled).map((o) => o.skillId));
  }

  private getSessionDisabledSkillIds(): Set<string> {
    const disabled = this.ctx.session.config.tools?.disabledSkills;
    if (!disabled?.length) return new Set();
    return new Set(disabled);
  }

  private isSkillScopeDisabled(
    skillId: string,
    overrideDisabled: Set<string>,
    sessionDisabled: Set<string>
  ): boolean {
    return overrideDisabled.has(skillId) || sessionDisabled.has(skillId);
  }

  private buildPluginsFromSkills(): Array<{ type: 'local'; path: string }> {
    if (!this.ctx.skillsManager) return [];

    const skills = this.ctx.skillsManager.getEnabledSkills();
    const overrideDisabled = this.getOverrideDisabledSkillIds();
    const sessionDisabled = this.getSessionDisabledSkillIds();
    const plugins: Array<{ type: 'local'; path: string }> = [];

    for (const skill of skills) {
      if (this.isSkillScopeDisabled(skill.id, overrideDisabled, sessionDisabled)) continue;
      if (skill.sourceType === 'plugin' && skill.config.type === 'plugin') {
        plugins.push({ type: 'local', path: skill.config.pluginPath });
      }
    }

    return plugins;
  }

  private buildPluginsFromBuiltinSkills(): Array<{ type: 'local'; path: string }> {
    if (!this.ctx.skillsManager) return [];

    const skills = this.ctx.skillsManager.getEnabledSkills();
    const overrideDisabled = this.getOverrideDisabledSkillIds();
    const sessionDisabled = this.getSessionDisabledSkillIds();
    const plugins: Array<{ type: 'local'; path: string }> = [];
    const wrappersRoot = defaultBuiltinSkillPluginRoot();

    for (const skill of skills) {
      if (this.isSkillScopeDisabled(skill.id, overrideDisabled, sessionDisabled)) continue;
      if (skill.sourceType === 'builtin' && skill.config.type === 'builtin') {
        if (skill.config.spaceOnly === true && !this.ctx.session.context?.spaceId) continue;
        const wrapperDir = builtinSkillPluginPath(wrappersRoot, skill.config.commandName);
        plugins.push({ type: 'local', path: wrapperDir });
      }
    }

    return plugins;
  }

  private getMcpServersFromSkills(): Record<string, McpServerConfig> {
    if (!this.ctx.skillsManager || !this.ctx.appMcpServerRepo) return {};

    const skills = this.ctx.skillsManager.getEnabledSkills();
    const overrideDisabled = this.getOverrideDisabledSkillIds();
    const sessionDisabled = this.getSessionDisabledSkillIds();
    const effectivelyEnabled = this.getEffectivelyEnabledAppServerIds();
    const servers: Record<string, McpServerConfig> = {};

    for (const skill of skills) {
      if (this.isSkillScopeDisabled(skill.id, overrideDisabled, sessionDisabled)) continue;
      if (skill.sourceType !== 'mcp_server' || skill.config.type !== 'mcp_server') continue;

      const appServer = this.ctx.appMcpServerRepo.get(skill.config.appMcpServerId);
      if (!appServer) continue;

      if (effectivelyEnabled !== null) {
        if (!effectivelyEnabled.has(appServer.id)) continue;
      } else if (!appServer.enabled) {
        continue;
      }

      const validation = this.validateAppMcpServer(appServer);
      if (!validation.valid) {
        this.logger.warn(`Skipping MCP server skill "${skill.name}": ${validation.error}`);
        continue;
      }

      servers[skill.name] = this.appMcpServerToSdkConfig(appServer);
    }

    return servers;
  }

  private getEffectivelyEnabledAppServerIds(): Set<string> | null {
    const effective = this.resolveEffectiveRegistryServers();
    return effective === null ? null : new Set(effective.map((s) => s.id));
  }

  private resolveEffectiveRegistryServers(): AppMcpServer[] | null {
    if (!this.ctx.appMcpServerRepo || !this.ctx.mcpEnablementRepo) return null;
    const registry = this.ctx.appMcpServerRepo.list();
    const chain = scopeChainForSession(this.ctx.session);
    const overrides = this.ctx.mcpEnablementRepo.listForScopes(chain);
    return resolveMcpServers(this.ctx.session, registry, overrides);
  }

  private getMcpServersFromRegistry(): Record<string, McpServerConfig> {
    const effective = this.resolveEffectiveRegistryServers();
    if (effective === null) return {};

    const skilledServerIds = this.getSkilledAppServerIds();
    const servers: Record<string, McpServerConfig> = {};
    for (const entry of effective) {
      if (skilledServerIds.has(entry.id)) continue;
      const validation = this.validateAppMcpServer(entry);
      if (!validation.valid) {
        this.logger.warn(`Skipping configured MCP server "${entry.name}": ${validation.error}`);
        continue;
      }
      servers[entry.name] = this.appMcpServerToSdkConfig(entry);
    }
    return servers;
  }

  private getSkilledAppServerIds(): Set<string> {
    const skills = this.ctx.skillsManager?.listSkills() ?? [];
    const ids = new Set<string>();
    for (const skill of skills) {
      if (skill.sourceType !== 'mcp_server') continue;
      if (!isMcpServerSkillConfig(skill.config)) continue;
      ids.add(skill.config.appMcpServerId);
    }
    return ids;
  }

  private validateAppMcpServer(entry: AppMcpServer): ValidationResult {
    switch (entry.sourceType) {
      case 'stdio':
        if (!entry.command || entry.command.trim() === '') {
          return {
            valid: false,
            error: `stdio server "${entry.name}" is missing required field: command`,
          };
        }
        return { valid: true };
      case 'sse':
      case 'http':
        if (!entry.url || entry.url.trim() === '') {
          return {
            valid: false,
            error: `${entry.sourceType} server "${entry.name}" is missing required field: url`,
          };
        }
        return { valid: true };
      default: {
        const exhaustive: never = entry.sourceType;
        return {
          valid: false,
          error: `server "${entry.name}" has unknown sourceType: ${exhaustive}`,
        };
      }
    }
  }

  private appMcpServerToSdkConfig(server: {
    sourceType: AppMcpServerSourceType;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }): McpServerConfig {
    switch (server.sourceType) {
      case 'stdio':
        return {
          command: server.command!,
          ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
          ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        };
      case 'sse':
        return {
          type: 'sse',
          url: server.url!,
          ...(server.headers && Object.keys(server.headers).length > 0
            ? { headers: server.headers }
            : {}),
        };
      case 'http':
        return {
          type: 'http',
          url: server.url!,
          ...(server.headers && Object.keys(server.headers).length > 0
            ? { headers: server.headers }
            : {}),
        };
      default: {
        const _exhaustive: never = server.sourceType;
        throw new Error(`Unknown MCP server source type: ${_exhaustive}`);
      }
    }
  }
}
