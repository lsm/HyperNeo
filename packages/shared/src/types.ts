import type { ResolvedQuestion } from './state-types.ts';
import type { SDKConfig, ToolsPresetConfig } from './types/sdk-config.ts';
import type { SettingSource } from './types/settings.ts';
import type { DeclarativeToolGuard } from './types/space.ts';

// Re-export new provider types (note: Provider and ProviderInfo excluded to avoid conflicts with legacy types)
export type {
  ModelTier,
  ProviderCapabilities,
  ProviderContext,
  ProviderId,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from './provider/types';
export type {
  AppMcpServer,
  AppMcpServerSourceType,
  CreateAppMcpServerRequest,
  UpdateAppMcpServerRequest,
} from './types/app-mcp-server.ts';
// Re-export SDK config types for convenience
export type {
  AgentDefinition,
  AgentMcpServerSpec,
  AgentModel,
  AgentsConfig,
  ClaudeCodePreset,
  ConfigUpdateResult,
  EnvironmentSettings,
  McpHttpServerConfig,
  McpServerConfig,
  McpSettings,
  McpSSEServerConfig,
  McpStdioServerConfig,
  ModelSettings,
  NetworkSandboxSettings,
  OutputFormatConfig,
  PluginConfig,
  SandboxIgnoreViolations,
  SandboxSettings,
  SDKConfig,
  SdkBeta,
  SessionResumptionSettings,
  SystemPromptConfig,
  ThinkingConfig,
  ToolsPreset,
  ToolsPresetConfig,
  ToolsSettings,
  ValidationResult,
} from './types/sdk-config.ts';

// ============================================================================
// Unified Session Architecture Types
// ============================================================================

/**
 * Session type for unified session architecture
 * - 'worker': Standard coding session with full Claude Code system prompt
 * - 'lobby': Instance-level agent session
 * - 'space_task_agent': Task Agent session that orchestrates a single SpaceTask's workflow
 * - 'space_chat': Per-space coordinator session (space:chat:${spaceId}) — the human-facing interface for a Space
 */
export type SessionType = 'worker' | 'lobby' | 'space_task_agent' | 'space_chat';

/**
 * Context for lobby/space sessions.
 */
export interface SessionContext {
  roomId?: string; // Deprecated: legacy DB compatibility only
  lobbyId?: string;
  /** Space ID for Space system sessions */
  spaceId?: string;
  /** Task ID for Space Task Agent sessions */
  taskId?: string;
}

/**
 * Feature flags for session UI
 * Controls which features are available in ChatContainer
 */
export interface SessionFeatures {
  /** Enable rewind/checkpoint functionality */
  rewind: boolean;
  /** Enable worktree mode toggle */
  worktree: boolean;
  /** Enable coordinator mode toggle */
  coordinator: boolean;
  /** Enable archive/delete buttons */
  archive: boolean;
  /** Enable session info panel */
  sessionInfo: boolean;
}

/**
 * Default features for worker sessions (all enabled)
 * Workers use full Claude Code system prompt for coding tasks
 */
export const DEFAULT_WORKER_FEATURES: SessionFeatures = {
  rewind: true,
  worktree: true,
  coordinator: true,
  archive: true,
  sessionInfo: true,
};

/**
 * Default features for lobby sessions (all disabled).
 * @public
 */
export const DEFAULT_LOBBY_FEATURES: SessionFeatures = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
};

// Core session types
export interface SessionInfo {
  id: string;
  title: string;
  workspacePath: string | null;
  createdAt: string;
  lastActiveAt: string;
  status: SessionStatus;
  config: SessionConfig;
  metadata: SessionMetadata;
  worktree?: WorktreeMetadata;
  gitBranch?: string; // Current git branch for non-worktree sessions in git repos
  sdkSessionId?: string; // SDK's internal session ID for resuming conversations
  acpSessionId?: string; // ACP agent session ID for resuming ACP conversations
  /**
   * The workspace path (resolved) that was used as CWD when the SDK session was first
   * created. The SDK stores conversation files under
   * ~/.claude/projects/{encoded-sdkOriginPath}/{sdkSessionId}.jsonl
   * Persisting this allows reliable resume even when the session's effective CWD
   * changes (e.g., worktree is added/removed between daemon restarts).
   */
  sdkOriginPath?: string;
  availableCommands?: string[]; // Available slash commands for this session (persisted)
  processingState?: string; // Persisted agent processing state (JSON serialized AgentProcessingState)
  archivedAt?: string; // ISO timestamp when session was archived
  /** Session type - defaults to 'worker' for existing sessions */
  type?: SessionType;
  /** Context for room/lobby sessions */
  context?: SessionContext;
}

// Backward compatibility alias (use SessionInfo in new code)
export type Session = SessionInfo;

export interface WorktreeMetadata {
  isWorktree: true;
  worktreePath: string;
  mainRepoPath: string;
  branch: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface WorktreeCommitStatus {
  hasCommitsAhead: boolean;
  commits: CommitInfo[];
  baseBranch: string;
}

export type SessionStatus = 'active' | 'pending_worktree_choice' | 'paused' | 'ended' | 'archived';
export type { RuntimeState } from './types/neo';

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Supported AI providers
 * - 'anthropic': Default Claude API provider
 * - 'glm': Z.ai (智谱AI) via Anthropic-compatible API
 * - 'minimax': MiniMax via Anthropic-compatible API
 * - 'deepseek': DeepSeek via Anthropic-compatible API
 * - 'kimi': Kimi (Moonshot AI) via Anthropic-compatible API
 * - 'openrouter': OpenRouter Anthropic-compatible API gateway
 * - 'ollama': Local Ollama through the native /api/chat endpoint
 * - 'ollama-cloud': Ollama Cloud through the native /api/chat endpoint
 * - 'anthropic-copilot': GitHub Copilot backend via Anthropic-compatible embedded server
 * - 'anthropic-codex': Anthropic-compatible HTTP bridge backed by OpenAI Responses
 * - 'acp': ACP-compatible agent runtime over JSON-RPC stdio
 */
export type Provider =
  | 'anthropic'
  | 'glm'
  | 'minimax'
  | 'deepseek'
  | 'kimi'
  | 'openrouter'
  | 'ollama'
  | 'ollama-cloud'
  | 'anthropic-copilot'
  | 'anthropic-codex'
  | 'acp';

/**
 * Provider-specific configuration
 * Allows per-session API key overrides
 */
export interface ProviderConfig {
  /** Provider-specific API key (optional, uses global env var if not set) */
  apiKey?: string;
  /** Custom base URL override (optional, uses provider default if not set) */
  baseUrl?: string;
  /** Additional provider-specific options */
  [key: string]: unknown;
}

/**
 * Information about an available provider
 */
export interface ProviderInfo {
  /** Provider identifier */
  id: Provider;
  /** Display name */
  name: string;
  /** API base URL (undefined for default Anthropic) */
  baseUrl?: string;
  /** Available model IDs for this provider */
  models: string[];
  /** Whether this provider is configured (has API key) */
  available: boolean;
}

/**
 * Thinking level options for extended thinking
 *
 * Sets maxThinkingTokens budget for the SDK:
 * - 'off': No thinking budget - SDK default behavior
 * - 'think8k': 8000 tokens thinking budget
 * - 'think16k': 16000 tokens thinking budget
 * - 'think24k': 24000 tokens thinking budget
 * - 'think32k': 31999 tokens thinking budget
 *
 * Note: The "ultrathink" keyword is NOT auto-appended. Users must type it explicitly if needed.
 */
export type ThinkingLevel = 'off' | 'think8k' | 'think16k' | 'think24k' | 'think32k';

/**
 * Mapping from ThinkingLevel to maxThinkingTokens value
 */
export const THINKING_LEVEL_TOKENS: Record<ThinkingLevel, number | undefined> = {
  off: undefined,
  think8k: 8000,
  think16k: 16000,
  think24k: 24000,
  think32k: 31999,
};

/**
 * Human-readable labels for thinking levels
 */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  think8k: 'Think 8k',
  think16k: 'Think 16k',
  think24k: 'Think 24k',
  think32k: 'Think 32k',
};

/**
 * Provider thinking mode capabilities
 * - 'off': Provider does not support thinking
 * - 'on': Provider supports binary on/off thinking
 * - 'granular': Provider supports token-budget thinking levels
 */
export const PROVIDER_THINKING_MODES: Record<Provider, 'off' | 'on' | 'granular'> = {
  anthropic: 'granular',
  glm: 'granular',
  kimi: 'on',
  minimax: 'off',
  deepseek: 'granular',
  openrouter: 'granular',
  ollama: 'off',
  'ollama-cloud': 'off',
  'anthropic-copilot': 'off',
  'anthropic-codex': 'granular',
  acp: 'granular',
};

/**
 * Normalize a thinking level value, converting legacy 'auto' to 'off'
 * and validating against known levels.
 */
export function normalizeThinkingLevel(level: string | undefined | null): ThinkingLevel {
  if (level === 'auto') return 'off';
  const valid: ThinkingLevel[] = ['off', 'think8k', 'think16k', 'think24k', 'think32k'];
  if (valid.includes(level as ThinkingLevel)) return level as ThinkingLevel;
  return 'off';
}

/**
 * Get the thinking level options appropriate for a provider's capabilities.
 * Returns an empty array for providers that don't support thinking.
 */
export function getThinkingOptionsForProvider(
  provider: string | undefined,
  mode?: 'off' | 'on' | 'granular'
): Array<{ value: ThinkingLevel; label: string }> {
  const resolvedMode = mode ?? PROVIDER_THINKING_MODES[provider as Provider] ?? 'granular';
  switch (resolvedMode) {
    case 'off':
      return [];
    case 'on':
      return [
        { value: 'off', label: 'Off' },
        { value: 'think32k', label: 'On' },
      ];
    case 'granular':
      return [
        { value: 'off', label: 'Off' },
        { value: 'think8k', label: 'Think 8k' },
        { value: 'think16k', label: 'Think 16k' },
        { value: 'think24k', label: 'Think 24k' },
        { value: 'think32k', label: 'Think 32k' },
      ];
  }
}

/**
 * Session configuration extending SDKConfig with UI-specific settings
 *
 * This interface combines all SDK options from SDKConfig with
 * HyperNeo-specific UI settings like autoScroll and queryMode.
 *
 * For backward compatibility:
 * - The existing `tools?: ToolsConfig` field is preserved for HyperNeo-specific UI settings
 * - SDKConfig's `tools` field (for tool selection) is available as `sdkToolsPreset`
 * - Other SDKConfig properties like `allowedTools`, `disallowedTools` are inherited directly
 */
export interface SessionConfig extends Omit<SDKConfig, 'tools'> {
  /**
   * AI provider to use for this session
   * @default 'anthropic'
   */
  provider?: Provider;

  /**
   * Provider-specific configuration (optional)
   * Allows per-session API key overrides
   */
  providerConfig?: ProviderConfig;

  /**
   * Model ID (required)
   * @example 'claude-sonnet-4-5-20250929'
   */
  model: string;

  /**
   * Maximum output tokens (legacy, not currently passed to SDK)
   * @deprecated Use SDK's default token limits
   */
  maxTokens: number;

  /**
   * Temperature for model responses (legacy, not currently passed to SDK)
   * @deprecated SDK manages temperature internally
   */
  temperature: number;

  /**
   * Auto-scroll to bottom when new messages arrive (UI-only)
   * @default true
   */
  autoScroll?: boolean;

  /**
   * Coordinator mode - main agent delegates all work to specialist subagents
   * When enabled, the main agent can only use Task, TodoWrite, AskUserQuestion
   * @default false
   */
  coordinatorMode?: boolean;

  /**
   * Thinking level for extended thinking
   * Maps to maxThinkingTokens in SDK options
   * @default 'off'
   */
  thinkingLevel?: ThinkingLevel;

  /**
   * Query mode for message sending behavior
   * - 'immediate': Messages are enqueued for immediate delivery (default)
   * - 'manual': Messages are deferred until explicitly triggered
   *
   * Note: auto-defer behavior (messages enqueued during active processing)
   * is automatic and doesn't require a separate mode setting.
   * @default 'immediate'
   */
  queryMode?: 'immediate' | 'manual';

  /**
   * Legacy tools configuration for session (HyperNeo-specific UI settings)
   * Controls system prompt preset, setting sources, MCP tools, and HyperNeo tools
   *
   * This is different from SDK's tool selection. For SDK tool selection, use:
   * - sdkToolsPreset: Select which tools to enable (array or preset)
   * - allowedTools: Auto-allow specific tools without permission prompts
   * - disallowedTools: Disable specific tools entirely
   */
  tools?: ToolsConfig;

  /**
   * SDK tool selection configuration
   * Specifies which tools are available for the agent
   *
   * @example
   * // Use Claude Code preset (all default tools)
   * sdkToolsPreset: { type: 'preset', preset: 'claude_code' }
   *
   * @example
   * // Use specific tools only
   * sdkToolsPreset: ['Read', 'Write', 'Bash']
   */
  sdkToolsPreset?: ToolsPresetConfig;

  /**
   * Custom function to spawn the Claude Code process.
   * Used for testing to track SDK subprocess PID.
   * This is a runtime-only callback, not persisted to database.
   * @internal
   * @remarks Uses 'any' type to match SDK's SpawnOptions and SpawnedProcess
   * interfaces which are not directly exported from the SDK package.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnClaudeCodeProcess?: (options: any) => any;

  // Note: The following are inherited from SDKConfig and available:
  // - systemPrompt: Custom system prompt or Claude Code preset
  // - allowedTools: Auto-allow specific tools without permission prompts
  // - disallowedTools: Disable specific tools entirely
  // - agents: Custom subagent definitions
  // - sandbox: Sandbox configuration
  // - mcpServers: MCP server configuration
  // - outputFormat: Structured output JSON schema
  // - plugins: Plugin configurations
  // - betas: Beta feature flags
  // - settingSources: Setting file sources
  // - env: Environment variables
  // - maxTurns: Maximum conversation turns
  // - maxBudgetUsd: Cost limit
  // - fallbackModel: Fallback model ID
  // - permissionMode: Permission mode for SDK operations

  // ============================================================================
  // Unified Session Architecture Fields
  // ============================================================================

  /**
   * Session type for unified architecture
   * @default 'worker'
   */
  type?: SessionType;

  /**
   * Context for room/lobby sessions
   */
  context?: SessionContext;

  /**
   * Feature flags controlling UI capabilities
   * Defaults based on session type:
   * - worker: all features enabled
   * - room/lobby: all features disabled
   */
  features?: SessionFeatures;

  /**
   * Declarative tool guards from the workflow node agent definition.
   * Persisted in session config so they survive daemon restart and
   * session restore without needing the workflow definition at hand.
   * Compiled into SDK hooks at runtime by the query options builder.
   */
  toolGuards?: DeclarativeToolGuard[];
}

/**
 * Tools configuration for a session
 * Controls system prompt and (legacy) setting source selection.
 *
 * SDK Terms Reference:
 * - systemPrompt: { type: 'preset', preset: 'claude_code' } - The Claude Code system prompt
 * - settingSources: ['project', 'local', 'user'] - Which config files to load
 *
 * NOTE: Per-session MCP server enablement now flows through `app_mcp_servers`
 * + `mcp_enablement` (the unified registry). The legacy
 * `disabledMcpServers` field was removed in M5.
 */
export interface ToolsConfig {
  // System Prompt: Use Claude Code preset (default: true)
  // SDK option: systemPrompt: { type: 'preset', preset: 'claude_code' }
  // When false, uses empty/minimal system prompt
  useClaudeCodePreset?: boolean;
  // Setting Sources: retained for forward compatibility only.
  // `QueryOptionsBuilder` always emits `settingSources: []` so the SDK never
  // auto-loads `.mcp.json` / `settings.json` MCPs — the registry is the only
  // source of truth.
  settingSources?: SettingSource[];
  // Legacy field - deprecated, use settingSources instead
  loadSettingSources?: boolean;
  /**
   * Session-scoped skill disable list.
   *
   * IDs of `app_skills` rows that the user has disabled for *this session
   * only*. Acts as an additive filter on top of the global `enabled` flag and
   * any room-level overrides — a skill is injected into the SDK build only if:
   *   - the global registry row has `enabled === true`, AND
   *   - no room-level override sets `enabled === false`, AND
   *   - the skill ID is not in this list.
   *
   * Empty / undefined means "no session-level skill overrides", which is the
   * default and matches the pre-existing behaviour. Used by the session
   * Tools modal so users can opt skills out for this session without mutating
   * the global app-level registry.
   */
  disabledSkills?: string[];
}

/**
 * Global tools configuration
 * Two-stage control: 1) allowed or not, 2) default for new sessions
 * Stored at the daemon level, applies to all sessions
 *
 * SDK Terms Reference:
 * - systemPrompt: { type: 'preset', preset: 'claude_code' } - The Claude Code system prompt
 * - settingSources: ['project', 'local', 'user'] - Which config files to load
 */
export interface GlobalToolsConfig {
  // System Prompt settings
  systemPrompt: {
    // Claude Code preset: Use the official Claude Code system prompt
    // SDK option: systemPrompt: { type: 'preset', preset: 'claude_code' }
    claudeCodePreset: {
      allowed: boolean;
      defaultEnabled: boolean;
    };
  };
  // Setting Sources settings
  settingSources: {
    // Project settings: Load from settingSources: ['project', 'local']
    // Controls CLAUDE.md, .claude/settings.json, .claude/settings.local.json loading
    project: {
      allowed: boolean;
      defaultEnabled: boolean;
    };
  };
  // MCP tools settings
  mcp: {
    // Is loading project MCP allowed?
    allowProjectMcp: boolean;
    // Default for new sessions
    defaultProjectMcp: boolean;
  };
}

/**
 * Default global tools configuration
 * All features enabled by default, MCP disabled by default
 */
export const DEFAULT_GLOBAL_TOOLS_CONFIG: GlobalToolsConfig = {
  systemPrompt: {
    claudeCodePreset: {
      allowed: true,
      defaultEnabled: true, // Use Claude Code preset by default
    },
  },
  settingSources: {
    project: {
      allowed: true,
      defaultEnabled: true, // Load project settings by default
    },
  },
  mcp: {
    allowProjectMcp: true, // Allow but don't enable by default
    defaultProjectMcp: false,
  },
};

export interface SessionMetadata {
  messageCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  toolCallCount: number;
  titleGenerated?: boolean; // Flag to track if title has been auto-generated
  /** Set when a user manually renames; auto-title generation skips these. */
  titleSetBy?: 'user' | 'auto';
  workspaceInitialized?: boolean; // Flag to track if workspace (title + worktree) has been initialized
  lastContextInfo?: ContextInfo | null; // Last known context info (persisted)
  inputDraft?: string | null; // Draft input text (null to clear; persisted across sessions and devices)
  /**
   * Voice transcript staged by the daemon (session.appendVoiceDraft) for the
   * session's composer. Daemon-coordinated: reads return the COMPOSITION of
   * inputDraft + pending (when it fits the character limit whole) without
   * mutating anything, and a draft write clears the pending exactly when the
   * written text already contains it ("adoption" — containment, not
   * awareness: a composer whose saved text does not contain the transcript
   * never wipes it, but a very short transcript appearing as a coincidental
   * substring of an unrelated write is consumed too; it is not an absolute
   * never-wipe guarantee). Consumed by adoption writes, the voice-aware
   * send-clear, or a clear of an already-empty draft. null/absent = nothing
   * pending.
   */
  inputDraftVoicePending?: string | null;
  /**
   * Timestamped log of voice-transcript outbox entry ids merged into
   * `inputDraftVoicePending` (see session.appendVoiceDraft). The client's
   * durable outbox replays entries after a socket drop and uses this to skip a
   * retry that already committed — a single last-id marker would let an
   * out-of-order replay (two tabs flushing, or a timed-out entry retried after
   * a later one committed) double-merge the transcript. Entries are retained
   * for the client outbox's retry lifetime (24h), not a small count cap: an
   * entry can stay retryable for that whole window while unrelated direct
   * appends flow in, and evicting its id early would let the eventual replay
   * double-append. `ts` is ms since epoch.
   */
  inputDraftVoiceAppendLog?: Array<{ id: string; ts: number }> | null;
  removedOutputs?: string[]; // UUIDs of messages whose tool_result outputs were removed from SDK session file
  resolvedQuestions?: Record<string, ResolvedQuestion>; // Resolved AskUserQuestion responses, keyed by toolUseId
  // Cost tracking: SDK reports cumulative cost per run, but resets on agent restart
  // We track lastSdkCost to detect resets and costBaseline to preserve pre-reset totals
  lastSdkCost?: number; // Last SDK-reported total_cost_usd (resets when agent restarts)
  costBaseline?: number; // Accumulated cost from previous runs before last reset
  acpInstructionsSent?: boolean; // Whether first-turn ACP session instructions were sent
  /**
   * Capped audit trace of prior SDK session ids this NeoKai session has rotated
   * through via `/clear` (most-recent-last, last ~50). The current id lives in
   * `sdkSessionId`; this is only for retrospectives/debugging — nothing reads it
   * for behavior. NeoKai keys UI threading on its own session id, not these.
   */
  pastSdkSessionIds?: string[];
  /**
   * Fallback ACP context-usage estimate (tokens). AcpQueryAdapter seeds a new
   * conversation's usage from this when the provider emits no usage_update.
   * Cleared on a context reset so a fresh turn doesn't inherit the prior total.
   */
  acpContextUsageEstimate?: number;
  worktreeChoice?: {
    status: 'pending' | 'completed';
    choice?: 'worktree' | 'direct';
    createdAt?: string;
    completedAt?: string;
  };
  archivedWorktree?: {
    mainRepoPath: string;
    worktreePath: string;
    branch: string;
  };
  // Session architecture fields
  /** Type of session in architecture context */
  sessionType?: SessionType;
  /** For manager/worker: ID of the paired session */
  pairedSessionId?: string;
  /** For manager/worker: ID of the parent session */
  parentSessionId?: string;
  /** Current task being managed/executed */
  currentTaskId?: string;
  /** Crash recovery context */
  recoveryContext?: {
    lastKnownState: string;
    pendingInstruction?: string;
    retryCount: number;
  };
  /** Non-secret provenance for the configured system prompt used when a session was spawned. */
  promptProvenance?: {
    source: string;
    hash: string;
    agentId?: string;
    agentName?: string;
    workflowRunId?: string;
    workflowId?: string;
    nodeId?: string;
    nodeName?: string;
  };
}

// Message content types for streaming input (supports images and tool results)
export type MessageContent = TextContent | ImageContent | ToolResultContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string; // base64 encoded
  };
}

/**
 * Tool result content for responding to tool use requests (e.g., AskUserQuestion)
 * Used when sending tool results through the streaming input queue
 */
export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/**
 * Message image attachment
 * Represents an image that can be sent with a message
 */
export interface MessageImage {
  /**
   * Base64 encoded image data
   */
  data: string;

  /**
   * MIME type of the image
   */
  media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export type MessageDeliveryMode = 'immediate' | 'defer';

/**
 * Origin of a message — stored as a DB-level annotation on sdk_messages for frontend display.
 * This is NOT injected into the SDK message JSON blob; room/space agents do not see it.
 * - 'human': default for user-sent messages (NULL in DB treated as 'human')
 * - 'system': message was injected by the daemon system internally
 */
export type MessageOrigin = 'human' | 'system';

/**
 * Classification of an input injected into an agent session, used by the
 * injection layer to decide side-effects (e.g. per-turn context resets).
 *
 * - 'task': a workflow task input — the initial kickoff or a node→node handoff
 *   (synthetic, agent-origin). This is the only kind that may trigger a
 *   `resetContextPerTurn` context clear.
 * - 'human': a message from a human (continuation/intervention).
 * - 'system': a daemon-injected recovery nag (circuit-breaker, stuck-agent
 *   notice, restart recovery, `/compact`, etc.) — never a new turn.
 *
 * Connection retry, rate-limit/usage-limit watchdog re-enqueue, and
 * `sdkResumeChoice` do not flow through the inject layer at all (they use
 * `startQueryAndEnqueue` / the resume RPC), so they are naturally excluded.
 */
export type MessageInputKind = 'task' | 'human' | 'system';

/**
 * A HyperNeo-native action message stored alongside SDK messages in the chat.
 *
 * Used to present interactive prompts to the user from the daemon — for
 * example, asking whether to start a fresh SDK session when the transcript
 * file can no longer be found.
 *
 * The `type` field is intentionally distinct from all SDK message types so
 * the frontend can identify and route it without ambiguity.
 */
export type HyperNeoActionMessage = {
  type: 'hyperneo_action';
  uuid: string;
  session_id: string;
  action: 'sdk_resume_choice';
  resolved: boolean;
  chosenOption?: 'start_fresh' | 'leave_as_is';
  timestamp: number;
};

// Tool types
export interface Tool {
  name: string;
  description: string;
  category: string;
  parameters: unknown; // JSON Schema
}

export interface ToolBundle {
  name: string;
  tools: string[];
  description: string;
}

// Event types
export interface Event {
  id: string;
  sessionId: string;
  type: EventType;
  data: unknown;
  timestamp: string;
}

export type EventType =
  // Server → Client events (broadcasts)
  | 'sdk.message'
  | 'context.updated'
  | 'context.compacting' // Compaction started (lock UI)
  | 'context.compacted' // Compaction finished (unlock UI)
  | 'tools.loaded'
  | 'tools.unloaded'
  | 'session.created'
  | 'session.updated'
  | 'session.voiceLanded' // A voice transcript committed into inputDraftVoicePending (per-session channel)
  | 'session.deleted'
  | 'session.ended'
  | 'session.interrupted'
  | 'message.queued'
  | 'message.processing'
  | 'error'
  // Client → Server request events
  | 'session.create.request'
  | 'session.list.request'
  | 'session.get.request'
  | 'session.update.request'
  | 'session.delete.request'
  | 'message.send' // Already exists
  | 'message.list.request'
  | 'message.sdkMessages.request'
  | 'file.read.request'
  | 'file.list.request'
  | 'file.tree.request'
  | 'system.health.request'
  | 'system.config.request'
  | 'auth.status.request'
  // Server → Client response events
  | 'session.create.response'
  | 'session.list.response'
  | 'session.get.response'
  | 'session.update.response'
  | 'session.delete.response'
  | 'message.list.response'
  | 'message.sdkMessages.response'
  | 'file.read.response'
  | 'file.list.response'
  | 'file.tree.response'
  | 'system.health.response'
  | 'system.config.response'
  | 'auth.status.response'
  // Client presence/interaction events
  | 'message.cancel'
  | 'client.typing'
  | 'client.presence'
  | 'client.cursor'
  | 'client.action'
  | 'client.interrupt'
  | 'client.ack'
  // WebSocket heartbeat events (internal)
  | 'ping'
  | 'pong';

// File system types
export interface FileInfo {
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime: string;
}

export interface FileTree {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTree[];
}

export interface FileSnapshot {
  sessionId: string;
  timestamp: string;
  files: {
    path: string;
    content: string;
    hash: string;
  }[];
}

// Sub-agent types
export interface SubAgent {
  id: string;
  sessionId: string;
  parentId?: string;
  task: string;
  tools: string[];
  status: 'running' | 'completed' | 'error';
  result?: unknown;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// Health check
export interface HealthStatus {
  status: 'ok' | 'error';
  version: string;
  uptime: number;
  sessions: {
    active: number;
    total: number;
  };
}

// Authentication types
export type AuthMethod = 'oauth' | 'oauth_token' | 'api_key' | 'none';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
  scopes: string[];
  isMax?: boolean;
}

export interface AuthStatus {
  method: AuthMethod;
  isAuthenticated: boolean;
  user?: {
    email?: string;
    name?: string;
  };
  expiresAt?: number;
  source?: 'env' | 'database'; // Where the credentials come from
}

// Configuration
export interface DaemonConfig {
  version: string;
  claudeSDKVersion: string;
  defaultModel: string;
  maxSessions: number;
  storageLocation: string;
  authMethod: AuthMethod;
  authStatus: AuthStatus;
}

// Slash Command types
export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  aliases?: string[];
  category?: 'chat' | 'session' | 'system' | 'debug';
  requiresConfirmation?: boolean;
  parameters?: CommandParameter[];
}

export interface CommandParameter {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: unknown;
}

export interface CommandExecutionRequest {
  command: string;
  args?: string[];
  rawInput: string;
}

export interface CommandExecutionResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
  displayType?: 'text' | 'markdown' | 'json' | 'component';
}

// Context information types

/**
 * Category breakdown for context usage
 */
export interface ContextCategoryBreakdown {
  tokens: number;
  percent: number | null;
}

/**
 * API usage statistics from Claude response
 */
export interface ContextAPIUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests?: number; // SDK 0.1.69+
}

/**
 * Per-message-type token breakdown (SDK `getContextUsage()` messageBreakdown)
 */
export interface ContextMessageBreakdown {
  toolCallTokens: number;
  toolResultTokens: number;
  attachmentTokens: number;
  assistantMessageTokens: number;
  userMessageTokens: number;
  /**
   * Tokens consumed by content redirected into the conversation
   * (e.g. sub-agent outputs). Exposed by the SDK alongside other
   * per-category totals.
   */
  redirectedContextTokens?: number;
  /**
   * Tokens the SDK couldn't attribute to any single category —
   * useful for detecting breakdown drift over time.
   */
  unattributedTokens?: number;
  toolCallsByType?: Array<{ name: string; callTokens: number; resultTokens: number }>;
  attachmentsByType?: Array<{ name: string; tokens: number }>;
}

/**
 * Comprehensive context information sourced from the Claude Agent SDK
 * `query.getContextUsage()` call. Includes model info, token usage,
 * category breakdown, auto-compact threshold, and optional debugging
 * details (per-message breakdown).
 */
export interface ContextInfo {
  model: string | null;
  // Token usage
  totalUsed: number;
  totalCapacity: number;
  percentUsed: number;
  // Category breakdown
  breakdown: Record<string, ContextCategoryBreakdown>;
  // Optional additional info
  apiUsage?: ContextAPIUsage;
  // Auto-compaction (from SDK getContextUsage())
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  // Per-message-type breakdown for debugging heavy sessions
  messageBreakdown?: ContextMessageBreakdown;
  // Metadata
  lastUpdated?: number; // Timestamp of last update
  source?: 'stream' | 'context-command' | 'sdk-get-context-usage' | 'merged'; // Source of context data
}
