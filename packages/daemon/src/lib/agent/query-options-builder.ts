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

import { KimiProvider } from '../providers/kimi-provider.js';
import { getDataDir } from '../data-dir';
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
import { NON_DELEGATING_GENERAL_AGENT } from '../space/agents/custom-agent';
import type { PermissionMode } from '@hyperneo/shared/types/settings';
import { homedir } from 'os';
import { join } from 'path';
import type { Database } from '../../storage/database';
import type { AppMcpServerRepository } from '../../storage/repositories/app-mcp-server-repository';
import type { McpEnablementRepository } from '../../storage/repositories/mcp-enablement-repository';
import { resolveMcpServers, scopeChainForSession } from '../mcp/resolve-mcp-servers';
import { Logger } from '../logger';
import { getSessionModelInfo } from '../model-service';
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
import { isMessageDeliveryV2Enabled } from './message-delivery';
import {
  createOutputLimiterPostHook,
  createOutputLimiterPreHook,
  resolveConfig,
} from './output-limiter-hook';
import { isRunningUnderBun, resolveSDKCliPath } from './sdk-cli-resolver.js';

const log = new Logger('QueryOptionsBuilder');

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
  } catch (err) {
    log.warn(
      `Ignoring invalid declarative tool guard pattern ${JSON.stringify(guard.pattern)}: ${err instanceof Error ? err.message : String(err)}`
    );
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

/**
 * Agent invocation tools that must be present when agents are configured.
 */
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

  // Space workers install this single built-in override only to constrain the
  // child's tool surface. It must not grant Agent/Task to a non-native parent
  // whose provider preset did not already expose delegation.
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

/**
 * Providers whose native SDK integration already knows the correct context
 * window and auto-compact behavior. No override needed.
 *
 * anthropic        — native Anthropic API, SDK knows all model context windows.
 * anthropic-copilot — Copilot bridge still routes to Anthropic API.
 * anthropic-codex  — Codex bridge uses real Codex model IDs (gpt-5.6-sol,
 *                   gpt-5.6-terra, etc.) with preferContextWindowMetadata=true,
 *                   so SDK reads the correct 1.05M/272k/128k windows from
 *                   /v1/models metadata instead of its hardcoded database.
 *                   CLAUDE_CODE_AUTO_COMPACT_WINDOW is set
 *                   explicitly so auto-compact fires at the correct threshold.
 * glm              — Sets CLAUDE_CODE_AUTO_COMPACT_WINDOW per model (1M for
 *                   glm-5.2[1m], 200k for the rest). The `[1m]` suffix is
 *                   recognised by the SDK's context-window resolver so the
 *                   SDK's effective window matches metadata and its own
 *                   auto-compact fires correctly (1M − 33k buffer). If `[1m]`
 *                   recognition regresses, the context-fetcher capacity-mismatch
 *                   warning surfaces it.
 */
export const NATIVE_CONTEXT_WINDOW_PROVIDER_IDS = [
  'anthropic',
  'anthropic-copilot',
  'anthropic-codex',
  'glm',
];

/**
 * Providers that cannot use SDK auto-compaction and need HyperNeo's fallback
 * trigger. Keep empty unless a provider cannot expose its real window through
 * SDK settings/env.
 */
export const PROVIDER_NO_SDK_AUTO_COMPACT: ReadonlySet<string> = new Set();

/**
 * Provider-specific SDK settings overrides.
 *
 * For native Anthropic providers the SDK already knows the correct context
 * window and auto-compact behaviour — no override needed.
 *
 * For non-native providers (OpenRouter, Ollama, custom endpoints, etc.) the
 * SDK cannot infer the provider model's real context window from its Anthropic
 * model alias. We pass the real window here so SDK auto-compaction fires at the
 * correct threshold without injecting `/compact` as prompt text.
 *
 * Providers/routes selected by `shouldUseHyperNeoCompactFallback` cannot use SDK
 * auto-compact at the right threshold. For these, we disable SDK auto-compact
 * and let HyperNeo's fallback handle compaction.
 */
export function shouldUseHyperNeoCompactFallback(providerId: string): boolean {
  // No provider should use the HyperNeo async /compact fallback. Kept as an
  // extension point only; `PROVIDER_NO_SDK_AUTO_COMPACT` is intentionally empty.
  //
  // History (do not re-special-case `kimi` here): Kimi's real window is 262k,
  // but the SDK's resolver only knows its internal model DB + the `[1m]` suffix
  // (→ 1M). Every other ID falls back to a hardcoded 200k. This was verified
  // empirically against SDK 0.3.x: `settings.autoCompactWindow` AND the
  // `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var are both CLAMPED to that resolved
  // window (passing 262144 still yields maxTokens=200000, threshold=167000); the
  // SDK never queries `/v1/models` for an Anthropic-compatible base; and injecting
  // `usage.model_context_window` into the `message_start` SSE event has no effect.
  // There is NO way to make the SDK believe 262k for Kimi.
  //
  // Previously Kimi was routed here and HyperNeo disabled SDK auto-compact
  // (`{ autoCompactEnabled: false }`) to chase the 262k headroom via an async
  // post-turn `/compact` fallback. That fallback fires AFTER turns/events, so it
  // cannot prevent overflow-within-a-turn or overflow-on-resume (the SDK pre-flights
  // against its 200k belief and, with auto-compact off, emits a 0-token terminal
  // "Prompt is too long" without ever calling Kimi). Result: Kimi overflowed at
  // ~7.7% of sessions vs ~0.6–4.2% for providers that keep native auto-compact.
  //
  // Letting Kimi use the SDK's native synchronous auto-compact (the default path)
  // arms it at 200k − 33k = 167k. Kimi's real window is 262k, so 167k is safely
  // below the rejection point — the SDK keeps context < 167k and Kimi always
  // accepts. The cost is compacting ~62k earlier than the unreachable 262k ideal;
  // the win is no more overflow (runtime or resume). This is the same tradeoff
  // every non-`[1m]` non-Anthropic model already accepts. Codex avoids it because
  // its bridge advertises the selected model's real context window through
  // `/v1/models` metadata. Kimi has no equivalent SDK-visible metadata path.
  return PROVIDER_NO_SDK_AUTO_COMPACT.has(providerId);
}

/**
 * SDK transcript retention (days) for every session the daemon spawns.
 *
 * The SDK/Claude CLI deletes chat transcripts idle longer than
 * `cleanupPeriodDays` (default 30) on startup, scanning ALL of
 * `~/.claude/projects` — including transcripts of long-idle HyperNeo sessions
 * the daemon DB still considers active and resumable. A purged transcript
 * wedges the session's delivery queue on `sdk_resume_choice` forever (the
 * resume can never succeed and nothing dead-letters it). Retention is
 * therefore owned solely by HyperNeo: session archive moves transcripts to
 * `~/.hyperneo/claude-session-archives/`; live sessions' transcripts must never
 * be swept by the subprocess. The SDK documents a large value as the way to
 * opt out of cleanup (min 1; `persistSession: false` would break resume).
 */
export const SDK_TRANSCRIPT_RETENTION_DAYS = 3650;

export function buildProviderSettings(
  providerId: string,
  contextWindow?: number | null,
  modelId?: string | null
): Settings | undefined {
  if (NATIVE_CONTEXT_WINDOW_PROVIDER_IDS.includes(providerId)) {
    return undefined;
  }

  // Kimi K3 (both the 1M flagship and the 256K-capped `k3-256k` variant) is
  // unknown to the SDK's internal resolver, which falls back to its 200k default
  // and clamps any override. We pass the real window explicitly
  // (belt-and-suspenders with the env var set in KimiProvider.buildSdkConfig),
  // resolving the correct size per K3 variant — 1M for the flagship, 256K for
  // `k3-256k`.
  if (providerId === 'kimi' && modelId && KimiProvider.isKimiK3Model(modelId)) {
    return {
      autoCompactEnabled: true,
      autoCompactWindow: KimiProvider.resolveContextWindow(modelId),
    };
  }

  if (shouldUseHyperNeoCompactFallback(providerId)) {
    // SDK auto-compact would fire at the wrong threshold (200k fallback
    // instead of the real model window). Disable it and let HyperNeo's
    // fallback trigger handle compaction at the SDK-style reserve threshold.
    return { autoCompactEnabled: false };
  }

  // When the real context window is unknown (provider metadata did not report
  // one), do NOT silently disable SDK auto-compaction — that creates a dead
  // zone with no compaction path at all and guarantees context overflow.
  // Returning `undefined` lets the SDK use its built-in auto-compact (enabled by
  // default with its 200k fallback window). This is strictly better than
  // disabling: correct for the common (>=200k) case, and the reactive
  // prompt-too-long recovery (SpaceRuntime) handles any sub-200k mismatch.
  const autoCompactWindow = contextWindow;
  if (!autoCompactWindow) {
    return undefined;
  }

  // Keep SDK auto-compaction enabled for non-native providers only when we can
  // provide the provider model's real context window. This lets the SDK trigger
  // compaction through its internal control flow instead of receiving
  // `/compact` as ordinary prompt text from the streaming input generator.
  return {
    autoCompactEnabled: true,
    autoCompactWindow,
  };
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
  private readonly logger = new Logger('QueryOptionsBuilder');

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
    return this.computeEffectiveMcpServers();
  }

  /**
   * Compute the full effective MCP-server map for this session by merging the
   * three independent sources, with deliberate precedence:
   *
   *   runtime (session.config.mcpServers)  >  skill-wrapped  >  registry
   *
   * Runtime servers (`space-agent-tools`, `node-agent`, `db-query`, …) are
   * spread last so they always win on a name collision — they are in-process
   * servers other subsystems depend on, and a registry row must never replace
   * or drop one (e.g. a user naming a registry entry `space-agent-tools`).
   * Skill-wrapped servers win over bare registry entries because an enabled
   * `mcp_server` skill is an explicit user wrapper.
   *
   * `session.config.mcpServers` is reserved for genuine runtime servers only;
   * TaskAgentManager no longer copies registry configs into it, so registry
   * disable/update/delete reconciles cleanly (no stale copy to resurrect). See
   * {@link getMcpServersFromRegistry} for the registry path and task #853.
   *
   * Returns `undefined` when no source contributes any server, preserving the
   * SDK's "no servers" state.
   */
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
    const modelInfo = await getSessionModelInfo(this.ctx.session);
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
    const pluginsFromSkills = [
      ...this.buildPluginsFromSkills(),
      ...this.buildPluginsFromBuiltinSkills(),
    ];
    const mergedEnv = this.getMergedEnvironmentVars();
    const sdkCliPath = this.getSDKCliPath();

    // Effective MCP servers: registry (skill-less) + skill-wrapped + runtime.
    // Precedence and sources are documented on `computeEffectiveMcpServers()`.
    // Enablement is fully resolved via the registry + `mcp_enablement` overrides;
    // whatever enters here is the effective set for this session.
    const mergedMcpServers = this.computeEffectiveMcpServers();

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
      // Inline `settings` is the SDK's flag-settings layer — it takes precedence
      // over the on-disk user/project settings, so the daemon's transcript
      // retention cannot be narrowed by ~/.claude/settings.json. Retention is
      // set for every provider (spread first so provider overrides still apply
      // to their own keys, but nothing overrides retention).
      settings: {
        ...buildProviderSettings(
          providerId,
          modelInfo?.contextWindow,
          this.ctx.session.config.model
        ),
        cleanupPeriodDays: SDK_TRANSCRIPT_RETENTION_DAYS,
      },

      // ============ Streaming ============
      // Partial/streaming messages (`stream_event`) double as a LIVENESS
      // heartbeat for the delivery-turn stall watchdog. A model that thinks or
      // generates for longer than the no-activity window (default 3min) without
      // emitting a COMPLETE message would otherwise look like a hang and trip
      // the watchdog; with partials on, each token delta bumps it so an
      // alive-but-quiet turn is never mistaken for a stall. Enabled when durable
      // delivery v2 is on (the only path that arms the watchdog); an explicit
      // per-session override still wins. Partials are intercepted in
      // SDKMessageHandler.handleMessage and never persisted/broadcast, so this
      // does not bloat the DB.
      includePartialMessages: config.includePartialMessages ?? isMessageDeliveryV2Enabled(),

      // ============ File Checkpointing ============
      // Enable file change tracking for rewind capability
      // Default to true unless explicitly disabled
      enableFileCheckpointing: config.enableFileCheckpointing ?? true,

      // ============ Hooks ============
      hooks,

      // ============ Callbacks ============
      canUseTool: this.canUseTool,
      onUserDialog: async (request) => {
        if (request.dialogKind === 'refusal_fallback_prompt') {
          return { behavior: 'completed', result: { continue: true } };
        }
        return { behavior: 'cancelled' };
      },
      supportedDialogKinds: config.fallbackModel ? ['refusal_fallback_prompt'] : undefined,
    };

    // ============ Space Chat Session Restrictions ============
    // Space chat sessions are read-only coordinators — they can read files, run
    // diagnostics, and spawn read-only SDK subagents for lightweight investigation.
    // File editing tools (Write/Edit/NotebookEdit) are excluded; the agent uses its
    // space-agent-tools MCP server for all coordination operations.
    if (this.ctx.session.type === 'space_chat') {
      // The long-horizon coordinator runs in this session. When its config
      // carries a curated `sdkToolsPreset` (set at provisioning via
      // SpaceRuntimeService.setupSpaceAgentSession from
      // LONG_HORIZON_AGENT_BUILTIN_TOOLS), honor it — the preset IS the
      // coordinator's read-only tool surface and must not be clobbered. A
      // genuine plain space:chat (no preset configured) falls back to the
      // hardcoded restricted allowlist below.
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
    let thinkingConfig = this.thinkingLevelToThinkingConfig(thinkingLevel, thinkingModes);

    // Kimi K3 accepts an enabled `thinking` payload (budget_tokens) on the
    // Anthropic-compatible endpoint — it advertises low/high/max efforts — so the
    // granular budget selected above is emitted as-is. K3 thinking cannot be
    // turned off (it is always on), so an explicit 'off'/'disabled' level is
    // dropped to let K3 run at its default effort instead of sending a
    // `disabled` payload it ignores. Kimi K2.7 models require thinking to be
    // explicitly enabled, so force a conservative default budget when the
    // effective level is off or disabled.
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

      // The SDK applies a single `thinking` option to the whole query (primary
      // model + fallback). Both K3 and K2.7 accept an enabled budget, so a mixed
      // chain is satisfiable when a thinking level is selected. The only
      // unsatisfiable case is an effective 'off'/disabled level on a mixed
      // K3↔K2.7 chain (K3 emits nothing while K2.7 requires enabled thinking).
      const fallbackModel = this.ctx.session.config.fallbackModel;
      if (fallbackModel) {
        const primaryIsK3 = KimiProvider.isKimiK3Model(selectedModel);
        const fallbackIsK3 = KimiProvider.isKimiK3Model(fallbackModel);
        const primaryIsK2 = KimiProvider.isKimiK2Point7Model(selectedModel);
        const fallbackIsK2 = KimiProvider.isKimiK2Point7Model(fallbackModel);
        const mixedChain = (primaryIsK3 && fallbackIsK2) || (primaryIsK2 && fallbackIsK3);
        if (mixedChain && (!thinkingConfig || thinkingConfig.type === 'disabled')) {
          // Both K3 and K2.7 accept an enabled budget, so a mixed chain is
          // always satisfiable. K3 cannot be disabled while K2.7 requires
          // enabled thinking, so force a conservative default budget rather
          // than failing the query — this keeps the two model orderings
          // equivalent (K2.7-primary already forces 16k via the branch above).
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
   * - ~/.hyperneo/: For HyperNeo-specific configuration and state
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

    // Always include Claude and HyperNeo directories for settings and storage.
    const dataDir = getDataDir();
    directories.push(join(homedir(), '.claude'));
    directories.push(dataDir);

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
    providerEnvVars.add('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    const processProviderEnvVars = new Set(providerEnvVars);
    processProviderEnvVars.add('CLAUDE_CODE_SUBAGENT_MODEL');
    processProviderEnvVars.add('ENABLE_TOOL_SEARCH');

    const excludedEnvVars = new Set(['PORT', 'HYPERNEO_PORT', 'NEOKAI_PORT']);
    const mergedEnv: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !excludedEnvVars.has(entry[0]) &&
          !processProviderEnvVars.has(entry[0])
      )
    );

    // For Anthropic provider (or default), only include auth tokens from process.env
    // Other provider vars are inherited via process.env by the SDK subprocess
    if (this.ctx.session.config.provider === 'anthropic' || !this.ctx.session.config.provider) {
      const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
      if (authToken?.startsWith('sk-ant-oat')) {
        mergedEnv.ANTHROPIC_AUTH_TOKEN = authToken;
      }
      const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (oauthToken) {
        mergedEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      }
    } else {
      // For non-Anthropic providers (GLM, Kimi, etc.), explicitly include provider
      // env vars from process.env in options.env so the SDK subprocess environment
      // has the same provider routing values. Filesystem settings precedence is
      // handled separately by QueryRunner, which also injects these values into
      // Options.settings.env (the SDK flag-settings layer).
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
        'CLAUDE_CODE_SUBAGENT_MODEL',
        'ENABLE_TOOL_SEARCH',
      ];
      for (const key of providerVars) {
        const value = process.env[key];
        if (value !== undefined && value !== '') {
          mergedEnv[key] = value;
        }
      }
    }

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
   * Bash sub-config.
   *
   * Workflow tool guards (declarative deny/allow rules) run next so they
   * evaluate the original tool input, before the output-limiter hook mutates
   * Bash commands into a truncation wrapper.
   *
   * The output-limiter hook is added last in the PreToolUse chain when
   * enabled in global settings. It mutates Bash/Read/Grep inputs to cap
   * output size before the tool runs, preventing a single large output from
   * overflowing the model context window. It only mutates input and does
   * not emit a permission decision, so it cannot bypass restrictive
   * permission modes.
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

    // Workflow tool guards (declarative deny/allow rules). These run
    // before the output-limiter mutation so regexes match the original
    // command shape (e.g. `^rm\s+-rf`).
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

    // Output limiter (PreToolUse): inject limit parameters for Read and Grep
    // so the tools fetch less data. Bash is NOT handled here — it is truncated
    // post-execution via updatedToolOutput in the PostToolUse hook below.
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

    // PostToolUse: loop detector (failure ring) + output limiter (Bash
    // truncation via updatedToolOutput). Commands run unwrapped, so exit
    // codes, heredocs, cwd, and sandbox behavior are all preserved.
    const postHooks: NonNullable<Options['hooks']>['PostToolUse'] = [
      { hooks: [loopDetectorHooks.postToolUse] },
    ];
    if (outputLimiterEnabled) {
      postHooks.push({ hooks: [createOutputLimiterPostHook(outputLimiterSettings)] });
    }
    hooks.PostToolUse = postHooks;

    // PostToolUseFailure observer feeds the Bash detector's outcome ring.
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
   * `~/.hyperneo/skill-plugins/{commandName}/` by `SkillsManager.ensureBuiltinPluginWrappers()`
   * during daemon startup. The wrapper has the layout the Claude Agent SDK
   * requires for `plugins: [{ type: 'local', path }]`:
   *
   *   <wrapper>/.claude-plugin/plugin.json
   *   <wrapper>/skills/<commandName>/   → symlink to ~/.hyperneo/skills/<commandName>/
   *
   * Without that wrapper the SDK silently drops the plugin (its loader
   * requires `.claude-plugin/plugin.json` at the root) and `/<commandName>`
   * never registers as a slash command. Pointing directly at
   * `~/.hyperneo/skills/<commandName>/` was the source of the
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

      // Surface invalid backing servers instead of emitting a broken config
      // that would fail to spawn. A skill that points at a misconfigured server
      // is skipped + logged, matching the registry path.
      const validation = this.validateAppMcpServer(appServer);
      if (!validation.valid) {
        this.logger.warn(`Skipping MCP server skill "${skill.name}": ${validation.error}`);
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
    const effective = this.resolveEffectiveRegistryServers();
    return effective === null ? null : new Set(effective.map((s) => s.id));
  }

  /**
   * Resolve the effective set of registry MCP servers for this session via the
   * pure {@link resolveMcpServers} function (session > room > space > registry
   * default). This matches `AppMcpLifecycleManager.getEnabledMcpConfigsForSession`
   * (same function) and the equivalent precedence implemented inline by the
   * `session.mcp.list` Tools-modal handler, so every spawn path agrees on which
   * servers a session sees.
   *
   * Returns `null` (not an empty array) when the enablement repo is not wired
   * — legacy/test contexts — so the skill bridge can fall back to the registry
   * row's own `enabled` flag and the registry path can no-op.
   */
  private resolveEffectiveRegistryServers(): AppMcpServer[] | null {
    if (!this.ctx.appMcpServerRepo || !this.ctx.mcpEnablementRepo) return null;
    const registry = this.ctx.appMcpServerRepo.list();
    const chain = scopeChainForSession(this.ctx.session);
    const overrides = this.ctx.mcpEnablementRepo.listForScopes(chain);
    return resolveMcpServers(this.ctx.session, registry, overrides);
  }

  /**
   * Build MCP-server entries for configured registry servers that have NO
   * wrapping `mcp_server` skill.
   *
   * This is the fix for the original bug: an enabled `app_mcp_servers` entry
   * (e.g. `codebase-memory-mcp`) whose tools an instruction skill references
   * was never attached to ordinary sessions, because only the skill bridge
   * exposed MCP tools. The registry + `mcp_enablement` overrides are now the
   * source of truth, so every effectively-enabled server reaches the session
   * regardless of whether a skill wraps it.
   *
   * Servers wrapped by ANY `mcp_server` skill are excluded here:
   *   - if the skill is enabled, the skill bridge already attaches the server
   *     (keyed by `skill.name`); re-adding it by `entry.name` would spawn a
   *     duplicate subprocess when the names differ (e.g. the `chrome-devtools`
   *     registry row vs the `chrome-devtools-mcp` skill);
   *   - if the skill is disabled, the user disabled the skill and the server
   *     must stay detached — the skill gate is intentionally preserved for
   *     skilled servers.
   *
   * Invalid entries are skipped with a structured warning rather than silently
   * omitted (see {@link validateAppMcpServer}).
   */
  private getMcpServersFromRegistry(): Record<string, McpServerConfig> {
    const effective = this.resolveEffectiveRegistryServers();
    // Legacy/test contexts (no mcpEnablementRepo): the skill bridge owns
    // skilled servers; skill-less registry servers are not reconciled here.
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

  /**
   * Return the set of `app_mcp_servers.id` values referenced by ANY registered
   * `mcp_server` skill (enabled or disabled). Used to keep the registry path
   * from double-attaching or bypassing the skill gate for skilled servers.
   */
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

  /**
   * Validate that a registry entry has the required fields for its source type.
   * Mirrors `AppMcpLifecycleManager.validateEntry` so both spawn paths reject
   * the same misconfigured entries instead of emitting broken SDK configs.
   */
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
