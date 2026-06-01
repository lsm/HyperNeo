/**
 * QueryOptionsBuilder - Builds SDK query options from session config
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles all SDK options construction including:
 * - System prompt configuration (custom string or Claude Code preset)
 * - Tool configuration (tools preset, allowed/disallowed tools)
 * - Agents/subagents configuration
 * - Sandbox configuration
 * - MCP servers configuration
 * - Output format (JSON schema)
 * - Beta features
 * - Environment settings
 * - Setting sources (project, local)
 * - Additional directories (worktree isolation)
 * - Hooks (output limiter)
 */

import type {
  CanUseTool,
  HookCallback,
  Options,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentDefinition,
  AppMcpServerSourceType,
  ClaudeCodePreset,
  DeclarativeToolGuard,
  Session,
  SkillEnablementOverride,
  SystemPromptConfig,
  ThinkingConfig,
  ThinkingLevel,
} from '@neokai/shared';
import {
  THINKING_LEVEL_TOKENS,
  normalizeThinkingLevel,
  PROVIDER_THINKING_MODES,
} from '@neokai/shared';
import type { McpServerConfig } from '@neokai/shared/types/sdk-config';
import type { PermissionMode } from '@neokai/shared/types/settings';
import { homedir } from 'os';
import { join } from 'path';
import type { Database } from '../../storage/database';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import type { McpEnablementRepository } from '../../storage/repositories/mcp-enablement-repository';
import { resolveMcpServers, scopeChainForSession } from '../mcp/resolve-mcp-servers';
import { getSessionModelInfo } from '../model-service.js';
import { requireModelContextWindow } from '../providers/codex-models';
import {
  getProviderContextManager,
  getProviderRegistry,
  initializeProviders,
  waitForOptionalProviderRegistration,
} from '../providers/factory.js';
import type { SettingsManager } from '../settings-manager';
import type { SkillsManager } from '../skills-manager';
import {
  builtinSkillPluginPath,
  defaultBuiltinSkillPluginRoot,
} from './builtin-skill-plugin-wrapper';
import { getCoordinatorAgents } from './coordinator-agents';
import { createLoopDetectorHooks } from './loop-detector-hook';
import { isRunningUnderBun, resolveSDKCliPath } from './sdk-cli-resolver.js';

/**
 * Compile a single declarative tool guard into a PreToolUse hook callback.
 * The guard specifies a tool matcher, a regex pattern against the tool input,
 * and a decision to apply when matched.
 *
 * Invalid regex patterns are caught at compile time and produce a no-op hook,
 * preventing a bad workflow row from crashing query startup.
 */
function compileToolGuard(guard: DeclarativeToolGuard): HookCallback {
  let pattern: RegExp;
  try {
    pattern = new RegExp(guard.pattern);
  } catch {
    // Bad pattern — guard is silently disabled so the session still works.
    return async () => ({});
  }
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    // tool_name filtering is handled by the SDK matcher field in buildHooks();
    // no redundant check here so regex-style matchers (e.g. "Write|Edit") work.
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

/**
 * Built-in tools exposed when expanding an undefined tool list for
 * non-Anthropic providers. Matches the coordinator-mode allowlist.
 */
const FULL_BUILTIN_TOOL_LIST = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'NotebookEdit',
  'TodoWrite',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'Skill',
  'ToolSearch',
];

/**
 * Agent invocation tools that must be present when agents are configured.
 */
const AGENT_INVOCATION_TOOLS = ['Task', 'TaskOutput', 'TaskStop'];

/**
 * Providers whose native SDK integration already includes agent tools in the
 * function schema when agents are configured. All other providers need an
 * explicit tool list because the SDK preset may omit Task/Agent tools.
 *
 * anthropic        — native Anthropic API, SDK handles agent tools correctly.
 * anthropic-copilot — Copilot bridge still routes to Anthropic API.
 */
const NATIVE_AGENT_TOOL_PROVIDERS = ['anthropic', 'anthropic-copilot'];

/**
 * Ensure agent invocation tools are present in the tool list when agents
 * are configured. Non-Anthropic SDK presets may omit Task from the function
 * schema even though the system prompt still describes agents, creating a
 * mismatch where the model sees agent descriptions but has no callable tool
 * to invoke them.
 *
 * @param tools      Current tools value (array, preset, undefined)
 * @param agents     Configured agents map
 * @param providerId Resolved provider identifier
 * @param sessionType Session type (space_chat is exempt)
 * @returns Updated tools value
 */
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

/**
 * Providers whose native SDK integration already knows the correct context
 * window and auto-compact behavior. No override needed.
 *
 * anthropic        — native Anthropic API, SDK knows all model context windows.
 * anthropic-copilot — Copilot bridge still routes to Anthropic API.
 */
const NATIVE_CONTEXT_WINDOW_PROVIDERS = ['anthropic', 'anthropic-copilot'];

/**
 * Provider-specific SDK settings overrides.
 *
 * For the Codex bridge, looks up the model's actual context window so the
 * SDK auto-compacts at the right threshold.
 * For other non-native providers, the caller should supply the model's
 * actual contextWindow so the SDK auto-compacts at the right threshold.
 */
export function buildProviderSettings(
  providerId: string,
  modelId?: string,
  contextWindow?: number
): Options['settings'] {
  if (providerId === 'anthropic-codex') {
    if (!modelId) {
      throw new Error(`Unknown Codex model auto-compact window: ${modelId ?? 'missing model'}`);
    }
    try {
      const actualContextWindow = requireModelContextWindow(modelId);
      return {
        autoCompactWindow: actualContextWindow,
      };
    } catch {
      throw new Error(`Unknown Codex model auto-compact window: ${modelId}`);
    }
  }

  // For non-native providers where the SDK can't discover the actual context
  // window (OpenRouter, Ollama, GLM, etc.), pass the model's contextWindow
  // so auto-compact triggers at the right percentage of actual capacity.
  if (!NATIVE_CONTEXT_WINDOW_PROVIDERS.includes(providerId) && contextWindow) {
    return { autoCompactWindow: contextWindow };
  }

  return undefined;
}

/**
 * Context interface - what QueryOptionsBuilder needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface QueryOptionsBuilderContext {
  readonly session: Session;
  readonly settingsManager: SettingsManager;
  readonly db?: Database;
  consumePendingResumeSessionAt?(): string | undefined;
  /** Peek at the pending resumeSessionAt without consuming it. Used by addSessionStateOptions which may be called multiple times. */
  peekPendingResumeSessionAt?(): string | undefined;
  /** Skills manager for injecting plugin/MCP server skills into SDK options. Optional for backwards compatibility. */
  readonly skillsManager?: SkillsManager;
  /** App MCP server repo for resolving mcp_server skill configs. Optional for backwards compatibility. */
  readonly appMcpServerRepo?: AppMcpServerRepository;
  /**
   * Unified per-scope MCP enablement repo. When provided, the builder resolves
   * skill-wrapped MCP servers against the session > room > space > registry
   * precedence chain so explicit per-scope overrides (including MCP M6
   * per-session toggles) filter the skill bridge too — not just the spawn
   * path's direct `config.mcpServers` injection.
   */
  readonly mcpEnablementRepo?: McpEnablementRepository;
  /**
   * Runtime skill overrides. When provided, a skill with `enabled: false` in this list
   * is excluded from injection even if it is globally enabled in the skills registry.
   */
  readonly skillOverrides?: SkillEnablementOverride[];
  /**
   * Declarative tool guards from the workflow node agent definition.
   * Compiled into SDK hooks at runtime — the builder has no hardcoded
   * knowledge of specific guards.
   */
  readonly toolGuards?: DeclarativeToolGuard[];
}

export class QueryOptionsBuilder {
  private canUseTool?: CanUseTool;

  constructor(private ctx: QueryOptionsBuilderContext) {}

  /**
   * Set the canUseTool callback for handling tool permissions
   * This is used for AskUserQuestion and other interactive tools
   */
  setCanUseTool(callback: CanUseTool): void {
    this.canUseTool = callback;
  }

  /**
   * Return MCP servers contributed by enabled skills for this session.
   * Skips skills disabled by runtime overrides and AppMcpServer entries that are disabled.
   * Useful for inspecting effective skill injection without running a full build.
   */
  getSkillMcpServers(): Record<string, McpServerConfig> {
    return this.getMcpServersFromSkills();
  }

  /**
   * Return the effective MCP server map for dynamic SDK updates.
   *
   * This mirrors the `build()` merge path without rebuilding the full SDK
   * options object. Runtime MCP attachment can happen after a streaming query
   * already exists; callers use this method before `queryObject.setMcpServers()`
   * so dynamic updates preserve skill-contributed MCP servers instead of
   * replacing the live query with only `session.config.mcpServers`.
   */
  getEffectiveMcpServers(): Record<string, McpServerConfig> | undefined {
    const mcpServers = this.getMcpServers();
    const mcpServersFromSkills = this.getMcpServersFromSkills();
    return this.mergeMcpServers(mcpServers, mcpServersFromSkills) as
      | Record<string, McpServerConfig>
      | undefined;
  }

  /**
   * Build complete SDK query options
   *
   * Maps all SessionConfig (which extends SDKConfig) options to SDK Options
   */
  async build(): Promise<Options> {
    const config = this.ctx.session.config;

    // Write file-only settings to .claude/settings.local.json before SDK starts
    // (permission ask lists, sandbox excludedCommands, outputStyle, attribution).
    // We no longer derive any SDK options from settings here — strictMcpConfig is
    // always true (MCP servers are fully controlled by the unified registry).
    // settingSources is configurable per session/space/agent and defaults to
    // ['user', 'project', 'local'] so CLAUDE.md and on-disk settings are loaded.
    await this.ctx.settingsManager.prepareSDKOptions();

    initializeProviders();
    await waitForOptionalProviderRegistration();

    // Translate model ID for SDK compatibility using provider context
    // FIX: Recreate context each time to pick up model changes from model switching
    // GLM model IDs (glm-5, glm-4.5-air) need to be mapped to SDK-recognized IDs
    // (default, haiku, opus) since the SDK only knows Anthropic model IDs
    const contextManager = getProviderContextManager();
    const providerContext = contextManager.createContext(this.ctx.session);
    const providerId = providerContext.provider.id;
    const sdkModelId = providerContext.getSdkModelId();
    let sdkFallbackModel: string | undefined;
    if (config.fallbackModel) {
      // For fallback model, we need to create a separate context
      const contextManager = getProviderContextManager();
      // Create a temporary session config with the fallback model
      const fallbackSession = {
        ...this.ctx.session,
        config: { ...this.ctx.session.config, model: config.fallbackModel },
      };
      const fallbackContext = contextManager.createContext(fallbackSession);
      sdkFallbackModel = fallbackContext.getSdkModelId();
    }

    // Build all configuration components
    const systemPromptConfig = this.buildSystemPrompt();
    const disallowedTools = this.getDisallowedTools();
    const allowedTools = this.getAllowedTools();
    const additionalDirectories = this.getAdditionalDirectories();
    const hooks = this.buildHooks();
    const permissionMode = this.getPermissionMode();
    const mcpServers = this.getMcpServers();
    const pluginsFromSkills = [
      ...this.buildPluginsFromSkills(),
      ...this.buildPluginsFromBuiltinSkills(),
    ];
    const mcpServersFromSkills = this.getMcpServersFromSkills();
    const mergedEnv = this.getMergedEnvironmentVars();
    const sdkCliPath = this.getSDKCliPath();

    // Merged MCP servers: skill-injected + session-config-injected.
    // No more legacy disabled-server filtering — enablement is fully resolved
    // upstream via the registry + `mcp_enablement` overrides; whatever enters
    // here is the effective set for this session.
    const mergedMcpServers = this.mergeMcpServers(mcpServers, mcpServersFromSkills);

    // Resolve model metadata so non-native providers get the correct
    // autoCompactWindow (the SDK defaults to 200k when it can't discover
    // the real context window, causing premature compaction on 1M models).
    const modelInfo = await getSessionModelInfo(this.ctx.session);
    const autoCompactWindow = modelInfo?.contextWindow;

    // Build final query options
    const queryOptions: Options = {
      // ============ Model & Execution ============
      model: sdkModelId,
      fallbackModel: sdkFallbackModel,
      maxTurns: config.maxTurns ?? Infinity,
      maxBudgetUsd: config.maxBudgetUsd,

      // ============ Process Spawning Hook ============
      // Used for testing to track SDK subprocess PID
      spawnClaudeCodeProcess: config.spawnClaudeCodeProcess,

      // ============ System Prompt ============
      systemPrompt: systemPromptConfig,

      // ============ Tools ============
      // sdkToolsPreset maps to SDK's tools option
      tools: config.sdkToolsPreset,
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,

      // ============ Agents/Subagents ============
      // agent: named agent for main thread (coordinator mode sets this)
      agent: config.agent,
      // Cast to SDK type - our AgentDefinition is compatible
      agents: config.agents as Options['agents'],

      // ============ Permissions ============
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',

      // ============ Sandbox ============
      // Cast to SDK type - our SandboxSettings is compatible
      sandbox: config.sandbox as Options['sandbox'],

      // ============ MCP Servers ============
      // Skill-injected MCP servers must appear in this map: strictMcpConfig
      // is now true for ALL sessions, so the SDK only sees servers placed
      // here by the resolver + skill bridge + runtime attachment. The unified
      // `app_mcp_servers` registry + `mcp_enablement` overrides table is the
      // single source of truth for which servers a session sees; nothing is
      // ever auto-loaded from `.mcp.json` or `settings.local.json` anymore.
      mcpServers: mergedMcpServers as Options['mcpServers'],
      // Always true — the SDK must only see MCP servers we explicitly place
      // in `mcpServers`. The unified registry + `mcp_enablement` overrides
      // table is the single source of truth. Auto-loading from `.mcp.json`
      // or `settings.local.json` is permanently off. See M5 of
      // `unify-mcp-config-model`.
      strictMcpConfig: true,

      // ============ Output Format ============
      outputFormat: config.outputFormat,

      // ============ Plugins ============
      plugins: this.mergePlugins(config.plugins, pluginsFromSkills),

      // ============ Beta Features ============
      betas: config.betas,

      // ============ Environment ============
      cwd: this.getCwd(),
      additionalDirectories,
      env: mergedEnv,
      // When running under Bun (dev, test, or compiled binary), set the subprocess
      // runtime to 'bun' so it shares the same Node.js compat layer (e.g. node:sqlite
      // requires v22.5+ but is available in Bun). Without this, CI runners with an
      // older Node.js on PATH would fail when spawning the SDK's cli.js subprocess.
      executable: config.executable ?? (isRunningUnderBun() ? 'bun' : undefined),
      executableArgs: config.executableArgs,
      pathToClaudeCodeExecutable: sdkCliPath,

      // ============ Settings ============
      // settingSources controls which on-disk settings files the SDK loads.
      // Default to ['user', 'project', 'local'] so CLAUDE.md and user/project
      // settings are loaded.
      //
      // SECURITY: strictMcpConfig is true for ALL sessions. This means the SDK
      // ONLY accepts MCP servers explicitly placed in the mcpServers map above.
      // It does NOT auto-load MCP servers from settings files, .mcp.json, or
      // any other source. The unified app_mcp_servers registry is the sole MCP
      // source. settingSources only affects non-MCP settings (permissions,
      // output style, CLAUDE.md content, etc.).
      settingSources:
        config.settingSources ?? this.ctx.settingsManager.getGlobalSettings().settingSources,
      settings: buildProviderSettings(providerId, config.model, autoCompactWindow),

      // ============ Streaming ============
      includePartialMessages: config.includePartialMessages,

      // ============ File Checkpointing ============
      // Enable file change tracking for rewind capability
      // Default to true unless explicitly disabled
      enableFileCheckpointing: config.enableFileCheckpointing ?? true,

      // ============ Hooks ============
      hooks,

      // ============ Callbacks ============
      canUseTool: this.canUseTool,
    };

    // ============ Space Chat Session Restrictions ============
    // Space chat sessions are read-only coordinators — they can read files, run
    // diagnostics, and spawn read-only SDK subagents for lightweight investigation.
    // File editing tools (Write/Edit/NotebookEdit) are excluded; the agent uses its
    // space-agent-tools MCP server for all coordination operations.
    if (this.ctx.session.type === 'space_chat') {
      const spaceAllowedBuiltinTools = [
        'Read',
        'Glob',
        'Grep',
        'Bash',
        'WebFetch',
        'WebSearch',
        'ToolSearch',
        'AskUserQuestion',
        'Task',
        'TaskOutput',
        'TaskStop',
      ];
      const spaceRestrictedBuiltinTools = ['Edit', 'Write', 'NotebookEdit'];

      // Space chat must not use Claude Code preset prompt.
      const systemPrompt = queryOptions.systemPrompt;
      if (
        typeof systemPrompt === 'object' &&
        systemPrompt !== null &&
        (systemPrompt as ClaudeCodePreset).type === 'preset' &&
        (systemPrompt as ClaudeCodePreset).preset === 'claude_code'
      ) {
        queryOptions.systemPrompt = undefined;
      }

      // Restrict space chat to coordinator-appropriate built-in tool set.
      queryOptions.tools = spaceAllowedBuiltinTools;

      // Auto-allow all explicitly configured MCP server tools (space-agent-tools + db-query).
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
      // strictMcpConfig + settingSources are already set unconditionally above.
    }

    // ============ Coordinator Mode ============
    // When coordinator mode is enabled, apply the coordinator agent to the main thread
    // and merge specialist agents with any user-defined agents
    if (config.coordinatorMode) {
      queryOptions.agent = 'Coordinator';
      const agents = getCoordinatorAgents(
        config.agents as Record<string, AgentDefinition> | undefined
      );

      // Inject worktree isolation into specialist agents that modify files.
      // The coordinator doesn't need it (it doesn't touch files), but subagents
      // run as separate CLI processes that don't inherit the parent's systemPrompt.append.
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

      // Allow all tools at session level so sub-agents can use them under dontAsk
      const existing = queryOptions.allowedTools ?? [];
      queryOptions.allowedTools = [...new Set([...existing, ...FULL_BUILTIN_TOOL_LIST])];
    }

    // ============ Provider-specific agent tool exposure ============
    queryOptions.tools = ensureAgentTools(
      queryOptions.tools,
      queryOptions.agents,
      providerId,
      this.ctx.session.type ?? 'worker'
    );

    // Remove undefined values to use SDK defaults
    const cleanedOptions = Object.fromEntries(
      Object.entries(queryOptions).filter(([_, v]) => v !== undefined)
    ) as Options;

    return cleanedOptions;
  }

  /**
   * Convert ThinkingLevel enum to SDK thinking option.
   * Maps the UI-friendly enum to SDK's new thinking API.
   * Provider-aware: returns undefined when thinking should be disabled.
   */
  private thinkingLevelToThinkingConfig(
    level: ThinkingLevel,
    thinkingModes: 'off' | 'on' | 'granular'
  ): ThinkingConfig | undefined {
    // Providers without thinking support: never emit thinking config
    if (thinkingModes === 'off') {
      return undefined;
    }

    const tokens = THINKING_LEVEL_TOKENS[level];

    // 'off' level: explicitly disable thinking so the SDK does not fall back
    // to its default behavior of enabling thinking when the property is absent.
    if (tokens === undefined) {
      return { type: 'disabled' };
    }

    // Preserve the selected budget for all providers that support thinking.
    // `thinkingModes === 'on'` only affects which UI options are shown (binary
    // on/off) — the daemon still respects the stored token budget.
    return { type: 'enabled', budgetTokens: tokens };
  }

  /**
   * Add resume and thinking tokens to options
   * Called separately since these depend on session state at query time
   */
  addSessionStateOptions(options: Options): Options {
    const result = { ...options } as Options & { thinking?: ThinkingConfig };

    // Add resume parameter if SDK session ID exists (session resumption)
    if (this.ctx.session.sdkSessionId) {
      result.resume = this.ctx.session.sdkSessionId;
    }

    const resumeSessionAt = this.ctx.peekPendingResumeSessionAt?.();
    if (resumeSessionAt && result.resume) {
      // Only emit resumeSessionAt when we have an active SDK session to resume.
      // Without resume (sdkSessionId), resumeSessionAt is meaningless and can
      // cause SDK startup failures.
      result.resumeSessionAt = resumeSessionAt;
    }

    // Resolve provider thinking mode so we can skip thinking config for
    // providers that do not support it. Prefer the live registry capability
    // (so custom OpenAI-compatible endpoints honour their per-config
    // `thinkingModes`) and fall back to the static map for built-ins. Static
    // fallback avoids API-key probes in CI when the registry is empty.
    const providerId = this.ctx.session.config.provider;
    let thinkingModes: 'off' | 'on' | 'granular' =
      PROVIDER_THINKING_MODES[providerId as keyof typeof PROVIDER_THINKING_MODES] ?? 'granular';
    try {
      if (providerId) {
        const provider = getProviderRegistry().get(providerId);
        const liveMode = provider?.capabilities?.thinkingModes;
        if (liveMode) thinkingModes = liveMode;
        // Per-model override beats the provider aggregate. Required for
        // providers (e.g. custom endpoints) that expose models with
        // heterogeneous thinking support — without this, a non-thinking
        // model on a provider that advertises `thinking: on` because
        // some sibling model supports it would emit `thinking` payloads
        // that the upstream rejects.
        const selectedModel = this.ctx.session.config.model;
        const perModelMode = selectedModel
          ? provider?.getModelThinkingMode?.(selectedModel)
          : undefined;
        if (perModelMode) thinkingModes = perModelMode;
      }
    } catch {
      // Registry not initialised (unit tests with reset registry) — keep static fallback.
    }
    // Add thinking configuration based on the session override, falling back to the app default.
    // Backward compatibility: legacy 'auto' is treated as 'off'.
    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    const thinkingLevel = normalizeThinkingLevel(
      this.ctx.session.config.thinkingLevel ?? globalSettings.thinkingLevel
    );
    const thinkingConfig = this.thinkingLevelToThinkingConfig(thinkingLevel, thinkingModes);
    if (thinkingConfig) {
      result.thinking = thinkingConfig;
    } else {
      delete (result as Record<string, unknown>).thinking;
    }

    return result as Options;
  }

  /**
   * Return the effective thinking level for this session, mirroring the
   * computation in `addSessionStateOptions` so callers (e.g. the Codex
   * bridge side-channel) use the same value.
   */
  getEffectiveThinkingLevel(): ThinkingLevel {
    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    return normalizeThinkingLevel(
      this.ctx.session.config.thinkingLevel ?? globalSettings.thinkingLevel
    );
  }

  private getSdkResumeWorkspacePath(): string | undefined {
    return this.ctx.session.sdkOriginPath ?? this.getCwd();
  }

  /**
   * Get the current working directory for the SDK
   */
  getCwd(): string | undefined {
    if (this.ctx.session.worktree) {
      return this.ctx.session.worktree.worktreePath;
    }
    return this.ctx.session.workspacePath ?? undefined;
  }

  /**
   * Build system prompt configuration
   *
   * Priority:
   * 1. SDKConfig systemPrompt (from session.config.systemPrompt)
   * 2. Legacy tools config (useClaudeCodePreset)
   * 3. Default: Claude Code preset
   *
   */
  private buildSystemPrompt(): Options['systemPrompt'] {
    const config = this.ctx.session.config;

    // Priority 1: Check if SDKConfig systemPrompt is explicitly set
    if (config.systemPrompt !== undefined) {
      return this.buildCustomSystemPrompt(config.systemPrompt);
    }

    // Priority 2: Fall back to legacy tools config
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

    // No Claude Code preset - use minimal system prompt or undefined
    // When worktree is used, still append isolation instructions
    if (this.ctx.session.worktree) {
      return this.joinSystemPromptAppendParts([this.getMinimalWorktreePrompt()]);
    }

    // If no worktree, systemPromptConfig remains undefined (SDK default behavior)
    return undefined;
  }

  /**
   * Build system prompt from SDKConfig systemPrompt
   *
   * Handles both custom string prompts and Claude Code preset configuration
   */
  private buildCustomSystemPrompt(systemPrompt: SystemPromptConfig): Options['systemPrompt'] {
    // Custom string prompt
    if (typeof systemPrompt === 'string') {
      return this.joinSystemPromptAppendParts([
        systemPrompt,
        this.ctx.session.worktree ? this.getWorktreeIsolationText() : undefined,
      ]);
    }

    // Claude Code preset configuration
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

    // Unknown format - return as-is
    return undefined;
  }

  private joinSystemPromptAppendParts(parts: Array<string | undefined>): string {
    return parts
      .map((part) => part?.trim())
      .filter((part): part is string => !!part)
      .join('\n\n');
  }

  /**
   * Get worktree isolation text to append to system prompt
   */
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

  /**
   * Get minimal worktree prompt (when Claude Code preset is disabled)
   */
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

  /**
   * Get list of disallowed tools based on session config
   *
   * Returns SDKConfig disallowedTools (explicit tools to disable)
   */
  private getDisallowedTools(): string[] {
    const config = this.ctx.session.config;
    const disallowedTools: string[] = [];

    // Add SDKConfig disallowedTools
    if (config.disallowedTools && config.disallowedTools.length > 0) {
      disallowedTools.push(...config.disallowedTools);
    }

    // Deduplicate
    return [...new Set(disallowedTools)];
  }

  /**
   * Get list of allowed tools based on session config
   *
   * These tools will be auto-approved without permission prompts
   */
  private getAllowedTools(): string[] {
    const config = this.ctx.session.config;

    if (config.allowedTools && config.allowedTools.length > 0) {
      return [...config.allowedTools];
    }

    return [];
  }

  /**
   * Get MCP servers configuration
   *
   * Priority:
   * 1. SDKConfig mcpServers (programmatic configuration)
   * 2. Undefined to let SDK auto-load from settings files
   */
  private getMcpServers(): Record<string, unknown> | undefined {
    // Use SDKConfig mcpServers if explicitly set
    const config = this.ctx.session.config;
    if (config.mcpServers !== undefined) {
      return config.mcpServers as Record<string, unknown>;
    }

    // Let SDK auto-load from settings files
    return undefined;
  }

  /**
   * Merge config MCP servers with skill-injected MCP servers.
   * Returns undefined when neither source has servers (preserves auto-load behavior).
   */
  private mergeMcpServers(
    configServers: Record<string, unknown> | undefined,
    skillServers: Record<string, McpServerConfig>
  ): Record<string, unknown> | undefined {
    const hasSkillServers = Object.keys(skillServers).length > 0;
    if (!configServers && !hasSkillServers) return undefined;
    return { ...skillServers, ...configServers };
  }

  /**
   * Merge config plugins with skill-injected plugins.
   * Returns undefined when neither source has plugins.
   */
  private mergePlugins(
    configPlugins: Options['plugins'],
    skillPlugins: Array<{ type: 'local'; path: string }>
  ): Options['plugins'] {
    if (!configPlugins && skillPlugins.length === 0) return undefined;
    return [...(configPlugins ?? []), ...skillPlugins];
  }

  /**
   * Get additional directories configuration
   *
   * Always includes:
   * - ~/.claude/: For settings, database, and worktree storage
   * - ~/.neokai/: For NeoKai-specific configuration and state
   *
   * For worktree sessions, also includes:
   * - /tmp: System temp for tools that write directly here (e.g. git hook tee, bun test)
   * - /tmp/claude: SDK sets TMPDIR=/tmp/claude, most shells (bash, fish, etc.) respect this
   * - /tmp/zsh-${uid}: Zsh's default behavior creates /tmp/zsh-UID paths
   *
   * This ensures shell operations (git commits, heredocs, etc.) work within the sandbox
   * without fighting any shell's natural temp file behavior.
   */
  private getAdditionalDirectories(): string[] | undefined {
    const directories: string[] = [];

    // Always include Claude and NeoKai directories for settings and storage
    directories.push(join(homedir(), '.claude'));
    directories.push(join(homedir(), '.neokai'));

    // For worktree sessions, also allow temp directories for shell operations
    if (this.ctx.session.worktree) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
      directories.push('/tmp', '/tmp/claude', `/tmp/zsh-${uid}`);
    }

    return directories;
  }

  /**
   * Get merged environment variables for SDK subprocess
   *
   * IMPORTANT: Provider env vars (GLM, etc.) are now applied to process.env
   * before SDK query creation, NOT passed via options.env.
   *
   * This method merges:
   * 1. Global settings env vars (from ~/.Claude/settings.json)
   * 2. Session config env vars (from session.config.env)
   *
   * Provider-specific env vars (ANTHROPIC_*, API_TIMEOUT_MS, etc.) are filtered out
   * because those are handled by applyEnvVarsToProcess() in AgentSession.
   *
   * Priority: Session env vars override global env vars.
   *
   * @returns Merged env vars (excluding provider-specific vars)
   */
  private getMergedEnvironmentVars(): Record<string, string> | undefined {
    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    const sessionEnv = this.ctx.session.config.env;

    // Provider-specific env vars that are managed by the provider system
    // These should NOT be passed via options.env as they won't work for GLM
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

    const mergedEnv: Record<string, string> = {};

    // 1. Add global settings env vars (filtered)
    if (globalSettings.env) {
      for (const [key, value] of Object.entries(globalSettings.env)) {
        if (value !== undefined && !providerEnvVars.has(key)) {
          mergedEnv[key] = value;
        }
      }
    }

    // 2. Add session config env vars (filtered, overrides global)
    if (sessionEnv) {
      for (const [key, value] of Object.entries(sessionEnv)) {
        if (value !== undefined && !providerEnvVars.has(key)) {
          mergedEnv[key] = value;
        }
      }
    }

    // 3. Explicitly include proxy environment variables for Dev Proxy support
    // These are set by the dev-proxy test helper and need to be passed to the SDK subprocess
    // See: https://github.com/dotnet/dev-proxy/issues/169
    const proxyEnvVars = [
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NODE_USE_ENV_PROXY',
      'NODE_EXTRA_CA_CERTS',
    ] as const;
    for (const key of proxyEnvVars) {
      const value = process.env[key];
      if (value !== undefined) {
        mergedEnv[key] = value;
      }
    }

    // Always return mergedEnv (not undefined) when proxy vars are present
    // This ensures SDK subprocess receives proxy environment variables
    return Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined;
  }

  /**
	/**
	 * Get permission mode with 2-layer priority system
	 *
	 * Priority:
	 * 1. Session config (highest priority)
	 * 2. Global settings
	 * 3. Default: 'bypassPermissions'
	 *
	 * @returns Permission mode for SDK operations
	 */
  private getPermissionMode(): PermissionMode {
    // Layer 1: Session config (highest priority)
    if (this.ctx.session.config.permissionMode) {
      if (this.ctx.session.config.permissionMode === 'default') {
        return 'bypassPermissions';
      }
      return this.ctx.session.config.permissionMode;
    }

    // Layer 2: Global settings
    const globalSettings = this.ctx.settingsManager.getGlobalSettings();
    if (globalSettings.permissionMode) {
      if (globalSettings.permissionMode === 'default') {
        return 'bypassPermissions';
      }
      return globalSettings.permissionMode;
    }

    // Layer 3: Default
    return 'bypassPermissions';
  }

  /**
   * Build hooks configuration
   *
   * Always installs the loop-detector hooks with NO matcher so they observe
   * every tool event. This is intentional: the PreToolUse hook needs to see
   * untracked tool calls (Edit, Write, …) so they can reset the streak
   * after a deny — otherwise an agent that takes a real corrective step
   * (e.g. `Edit foo.ts` then re-Read it) would stay permanently blocked.
   * The PostToolUse + PostToolUseFailure hooks observe Bash outcomes for
   * the failure-aware Bash dead-loop detector. The PreToolUse hook itself
   * filters internally on `DEFAULT_LOOP_DETECTOR_CONFIG.thresholds` and the
   * Bash sub-config. Tool guards from the workflow definition are appended
   * on top of the PreToolUse chain.
   */
  private buildHooks(): Options['hooks'] {
    const hooks: NonNullable<Options['hooks']> = {};
    const preToolUse: NonNullable<Options['hooks']>['PreToolUse'] = [];

    // Loop detector: NO matcher — the hooks must observe every tool call
    // so that untracked tools (Edit, Write, …) can serve as the
    // "different action" that breaks a denied streak, and so that every
    // Bash result is recorded against the failure ring. The PreToolUse
    // hook decides internally whether to track a tool
    // (DEFAULT_LOOP_DETECTOR_CONFIG.thresholds + bash sub-config) or
    // merely use the call as a streak-reset signal. Production wires
    // this with no arguments — the hook's `config` parameter exists only
    // so unit tests can exercise alternative thresholds and disabled mode.
    //
    // Single factory call: pre/post hooks SHARE state via the closure
    // returned by `createLoopDetectorHooks()`. Calling
    // `createLoopDetectorHook()` separately would produce disjoint
    // states and the Bash failure ring would never see outcomes from the
    // pre-hook's streak counter.
    const loopDetectorHooks = createLoopDetectorHooks();
    preToolUse.push({
      hooks: [loopDetectorHooks.preToolUse],
    });

    // Workflow tool guards (declarative deny/allow rules) layered on top.
    const guards = this.ctx.toolGuards;
    if (guards?.length) {
      // Group guards by matcher (tool name) to create one matcher entry per tool.
      // Skip malformed entries (null, non-object) so a bad persisted workflow
      // cannot crash query startup.
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

    if (preToolUse.length > 0) {
      hooks.PreToolUse = preToolUse;
    }
    // PostToolUse + PostToolUseFailure observers feed the Bash detector's
    // outcome ring. Installed unconditionally — they early-out on
    // non-Bash tools and when bash.enabled is false.
    hooks.PostToolUse = [{ hooks: [loopDetectorHooks.postToolUse] }];
    hooks.PostToolUseFailure = [{ hooks: [loopDetectorHooks.postToolUseFailure] }];
    return hooks;
  }

  /**
   * Get SDK CLI path
   *
   * Priority:
   * 1. Session config explicit path
   * 2. Auto-resolved path from SDK installation
   * 3. undefined (let SDK use its default)
   */
  private getSDKCliPath(): string | undefined {
    const config = this.ctx.session.config;

    // Priority 1: Explicit path from config
    if (config.pathToClaudeCodeExecutable) {
      return config.pathToClaudeCodeExecutable;
    }

    // Priority 2: Auto-resolve from SDK installation
    // This is critical for bundled binaries where SDK's internal
    // resolution produces virtual /$bunfs/root paths
    const resolvedPath = resolveSDKCliPath();
    if (resolvedPath) {
      return resolvedPath;
    }

    // Priority 3: Let SDK use its default resolution
    return undefined;
  }

  /**
   * Returns the set of skill IDs disabled by runtime-specific overrides.
   * A skill in this set must be excluded even if globally enabled.
   */
  private getOverrideDisabledSkillIds(): Set<string> {
    if (!this.ctx.skillOverrides?.length) return new Set();
    return new Set(this.ctx.skillOverrides.filter((o) => !o.enabled).map((o) => o.skillId));
  }

  /**
   * Returns the set of skill IDs disabled at the session scope.
   *
   * Session-level overrides come from `session.config.tools.disabledSkills`,
   * managed by the session Tools modal. They are additive on top of
   * runtime-specific overrides and the global `enabled` flag.
   */
  private getSessionDisabledSkillIds(): Set<string> {
    const disabled = this.ctx.session.config.tools?.disabledSkills;
    if (!disabled?.length) return new Set();
    return new Set(disabled);
  }

  /**
   * Returns true when the skill is disabled by runtime or session scope.
   * Either level is sufficient to exclude a skill that is globally enabled;
   * the session modal cannot promote skills above their inherited state.
   */
  private isSkillScopeDisabled(
    skillId: string,
    overrideDisabled: Set<string>,
    sessionDisabled: Set<string>
  ): boolean {
    return overrideDisabled.has(skillId) || sessionDisabled.has(skillId);
  }

  /**
   * Build plugin entries from enabled skills with sourceType === 'plugin'.
   * Runtime overrides with enabled=false exclude the skill even if globally enabled.
   * Returns an array of SdkPluginConfig objects for injection into options.plugins.
   */
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

  /**
   * Build plugin entries from enabled skills with sourceType === 'builtin'.
   *
   * Each builtin skill's commandName has a wrapper plugin materialised at
   * `~/.neokai/skill-plugins/{commandName}/` by `SkillsManager.ensureBuiltinPluginWrappers()`
   * during daemon startup. The wrapper has the layout the Claude Agent SDK
   * requires for `plugins: [{ type: 'local', path }]`:
   *
   *   <wrapper>/.claude-plugin/plugin.json
   *   <wrapper>/skills/<commandName>/   → symlink to ~/.neokai/skills/<commandName>/
   *
   * Without that wrapper the SDK silently drops the plugin (its loader
   * requires `.claude-plugin/plugin.json` at the root) and `/<commandName>`
   * never registers as a slash command. Pointing directly at
   * `~/.neokai/skills/<commandName>/` was the source of the
   * "Unknown command: /playwright" bug.
   *
   * Runtime overrides with enabled=false exclude the skill even if globally enabled.
   */
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

  /**
   * Build MCP server entries from enabled skills with sourceType === 'mcp_server'.
   * Runtime overrides with enabled=false exclude the skill even if globally enabled.
   * Resolves each skill's appMcpServerId to an AppMcpServer entry and maps it
   * to an McpServerConfig keyed by skill.name.
   *
   * Skill-injected MCP servers: must appear in mcpServers map for
   * strictMcpConfig sessions to accept them.
   *
   * MCP M6: when `mcpEnablementRepo` is available, the skill bridge also respects
   * explicit overrides in the `mcp_enablement` table along the session's scope
   * chain (session > room > space > registry). Without this, a user disabling a
   * skill-wrapped MCP server via the session Tools modal would not actually take
   * effect, because the skill bridge bypasses `config.mcpServers` (which the
   * spawn path resolves upstream).
   */
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
      // Skip silently if the referenced app_mcp_servers entry was deleted or no longer exists
      if (!appServer) continue;

      if (effectivelyEnabled !== null) {
        // Resolver result covers the full session > room > space > registry chain,
        // so an explicit session override to enable a globally-disabled server wins
        // here just as the spec calls for. Missing from the set ⇒ skip.
        if (!effectivelyEnabled.has(appServer.id)) continue;
      } else if (!appServer.enabled) {
        // Fallback for contexts that do not plumb mcpEnablementRepo (legacy unit
        // tests, ad-hoc builder usage): preserve the pre-M6 behaviour of only
        // honouring the registry default.
        continue;
      }

      servers[skill.name] = this.appMcpServerToSdkConfig(appServer);
    }

    return servers;
  }

  /**
   * Compute the set of AppMcpServer IDs that are effectively enabled for this
   * session given the session > room > space > registry precedence. Returns
   * `null` when the enablement repo isn't wired (legacy contexts), so callers
   * can fall back to the registry default.
   */
  private getEffectivelyEnabledAppServerIds(): Set<string> | null {
    if (!this.ctx.appMcpServerRepo || !this.ctx.mcpEnablementRepo) return null;

    const registry = this.ctx.appMcpServerRepo.list();
    const chain = scopeChainForSession(this.ctx.session);
    const overrides = this.ctx.mcpEnablementRepo.listForScopes(chain);
    const effective = resolveMcpServers(this.ctx.session, registry, overrides);
    return new Set(effective.map((s) => s.id));
  }

  /**
   * Convert an AppMcpServer to the SDK's McpServerConfig format.
   */
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
          ...(server.args ? { args: server.args } : {}),
          ...(server.env ? { env: server.env } : {}),
        };
      case 'sse':
        return {
          type: 'sse',
          url: server.url!,
          ...(server.headers ? { headers: server.headers } : {}),
        };
      case 'http':
        return {
          type: 'http',
          url: server.url!,
          ...(server.headers ? { headers: server.headers } : {}),
        };
      default: {
        const _exhaustive: never = server.sourceType;
        throw new Error(`Unknown MCP server source type: ${_exhaustive}`);
      }
    }
  }
}
