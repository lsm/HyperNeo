import type { ResolvedQuestion } from './state-types.ts';
import type { SDKConfig, ToolsPresetConfig } from './types/sdk-config.ts';
import type { SettingSource } from './types/settings.ts';
import type { DeclarativeToolGuard } from './types/space.ts';

export type {
  ModelTier,
  ProviderCapabilities,
  ProviderContext,
  ProviderId,
  ProviderSdkConfig,
  ProviderSessionConfig,
} from './provider/types.ts';
export type {
  AppMcpServer,
  AppMcpServerSourceType,
  CreateAppMcpServerRequest,
  UpdateAppMcpServerRequest,
} from './types/app-mcp-server.ts';
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

export type SessionType = 'worker' | 'lobby' | 'space_task_agent' | 'space_chat';

export interface SessionContext {
  roomId?: string;
  lobbyId?: string;
  spaceId?: string;
  taskId?: string;
}

export interface SessionFeatures {
  rewind: boolean;
  worktree: boolean;
  coordinator: boolean;
  archive: boolean;
  sessionInfo: boolean;
}

export const DEFAULT_WORKER_FEATURES: SessionFeatures = {
  rewind: true,
  worktree: true,
  coordinator: true,
  archive: true,
  sessionInfo: true,
};

/** @public */
export const DEFAULT_LOBBY_FEATURES: SessionFeatures = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
};

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
  gitBranch?: string;
  sdkSessionId?: string;
  acpSessionId?: string;
  sdkOriginPath?: string;
  availableCommands?: string[];
  processingState?: string;
  archivedAt?: string;
  type?: SessionType;
  context?: SessionContext;
}

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
export type { RuntimeState } from './types/neo.ts';

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

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  [key: string]: unknown;
}

export interface ProviderInfo {
  id: Provider;
  name: string;
  baseUrl?: string;
  models: string[];
  available: boolean;
}

export type ThinkingLevel = 'off' | 'think8k' | 'think16k' | 'think24k' | 'think32k';

export const THINKING_LEVEL_TOKENS: Record<ThinkingLevel, number | undefined> = {
  off: undefined,
  think8k: 8000,
  think16k: 16000,
  think24k: 24000,
  think32k: 31999,
};

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  think8k: 'Think 8k',
  think16k: 'Think 16k',
  think24k: 'Think 24k',
  think32k: 'Think 32k',
};

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

export function normalizeThinkingLevel(level: string | undefined | null): ThinkingLevel {
  if (level === 'auto') return 'off';
  const valid: ThinkingLevel[] = ['off', 'think8k', 'think16k', 'think24k', 'think32k'];
  if (valid.includes(level as ThinkingLevel)) return level as ThinkingLevel;
  return 'off';
}

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

export interface SessionConfig extends Omit<SDKConfig, 'tools'> {
  provider?: Provider;

  providerConfig?: ProviderConfig;

  model: string;

  maxTokens: number;

  temperature: number;

  autoScroll?: boolean;

  coordinatorMode?: boolean;

  thinkingLevel?: ThinkingLevel;

  queryMode?: 'immediate' | 'manual';

  tools?: ToolsConfig;

  sdkToolsPreset?: ToolsPresetConfig;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnClaudeCodeProcess?: (options: any) => any;

  type?: SessionType;

  context?: SessionContext;

  features?: SessionFeatures;

  toolGuards?: DeclarativeToolGuard[];
}

export interface ToolsConfig {
  useClaudeCodePreset?: boolean;
  settingSources?: SettingSource[];
  loadSettingSources?: boolean;
  disabledSkills?: string[];
}

export interface GlobalToolsConfig {
  systemPrompt: {
    claudeCodePreset: {
      allowed: boolean;
      defaultEnabled: boolean;
    };
  };
  settingSources: {
    project: {
      allowed: boolean;
      defaultEnabled: boolean;
    };
  };
  mcp: {
    allowProjectMcp: boolean;
    defaultProjectMcp: boolean;
  };
}

export const DEFAULT_GLOBAL_TOOLS_CONFIG: GlobalToolsConfig = {
  systemPrompt: {
    claudeCodePreset: {
      allowed: true,
      defaultEnabled: true,
    },
  },
  settingSources: {
    project: {
      allowed: true,
      defaultEnabled: true,
    },
  },
  mcp: {
    allowProjectMcp: true,
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
  titleGenerated?: boolean;
  titleSetBy?: 'user' | 'auto';
  workspaceInitialized?: boolean;
  lastContextInfo?: ContextInfo | null;
  inputDraft?: string | null;
  inputDraftVoicePending?: string | null;
  inputDraftVoiceAppendLog?: Array<{ id: string; ts: number }> | null;
  removedOutputs?: string[];
  resolvedQuestions?: Record<string, ResolvedQuestion>;
  lastSdkCost?: number;
  costBaseline?: number;
  refusalRewindTargetUuid?: string | null;
  acpInstructionsSent?: boolean;
  acpCommandIdentity?: string;
  acpSessionCommand?: string;
  pastSdkSessionIds?: string[];
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
  sessionType?: SessionType;
  pairedSessionId?: string;
  parentSessionId?: string;
  currentTaskId?: string;
  recoveryContext?: {
    lastKnownState: string;
    pendingInstruction?: string;
    retryCount: number;
  };
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
    data: string;
  };
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface MessageImage {
  data: string;

  media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export type MessageDeliveryMode = 'immediate' | 'defer';

export type MessageOrigin = 'human' | 'system';

export type MessageInputKind = 'task' | 'human' | 'system';

export type HyperNeoActionMessage = {
  type: 'hyperneo_action';
  uuid: string;
  session_id: string;
  action: 'sdk_resume_choice';
  resolved: boolean;
  chosenOption?: 'start_fresh' | 'leave_as_is';
  timestamp: number;
};

export interface Tool {
  name: string;
  description: string;
  category: string;
  parameters: unknown;
}

export interface ToolBundle {
  name: string;
  tools: string[];
  description: string;
}

export interface Event {
  id: string;
  sessionId: string;
  type: EventType;
  data: unknown;
  timestamp: string;
}

export type EventType =
  | 'sdk.message'
  | 'context.updated'
  | 'context.compacting'
  | 'context.compacted'
  | 'tools.loaded'
  | 'tools.unloaded'
  | 'session.created'
  | 'session.updated'
  | 'session.voiceLanded'
  | 'session.deleted'
  | 'session.ended'
  | 'session.interrupted'
  | 'message.queued'
  | 'message.processing'
  | 'error'
  | 'session.create.request'
  | 'session.list.request'
  | 'session.get.request'
  | 'session.update.request'
  | 'session.delete.request'
  | 'message.send'
  | 'message.list.request'
  | 'message.sdkMessages.request'
  | 'file.read.request'
  | 'file.list.request'
  | 'file.tree.request'
  | 'system.health.request'
  | 'system.config.request'
  | 'auth.status.request'
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
  | 'message.cancel'
  | 'client.typing'
  | 'client.presence'
  | 'client.cursor'
  | 'client.action'
  | 'client.interrupt'
  | 'client.ack'
  | 'ping'
  | 'pong';

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

export interface HealthStatus {
  status: 'ok' | 'error';
  version: string;
  uptime: number;
  sessions: {
    active: number;
    total: number;
  };
}

export type AuthMethod = 'oauth' | 'oauth_token' | 'api_key' | 'none';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
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
  source?: 'env' | 'database';
}

export interface DaemonConfig {
  version: string;
  claudeSDKVersion: string;
  defaultModel: string;
  maxSessions: number;
  storageLocation: string;
  authMethod: AuthMethod;
  authStatus: AuthStatus;
}

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

export interface ContextCategoryBreakdown {
  tokens: number;
  percent: number | null;
}

export interface ContextAPIUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests?: number;
}

export interface ContextMessageBreakdown {
  toolCallTokens: number;
  toolResultTokens: number;
  attachmentTokens: number;
  assistantMessageTokens: number;
  userMessageTokens: number;
  redirectedContextTokens?: number;
  unattributedTokens?: number;
  toolCallsByType?: Array<{ name: string; callTokens: number; resultTokens: number }>;
  attachmentsByType?: Array<{ name: string; tokens: number }>;
}

export interface ContextInfo {
  model: string | null;
  totalUsed: number;
  totalCapacity: number;
  percentUsed: number;
  breakdown: Record<string, ContextCategoryBreakdown>;
  apiUsage?: ContextAPIUsage;
  autoCompactThreshold?: number;
  sdkAutoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  messageBreakdown?: ContextMessageBreakdown;
  lastUpdated?: number;
  source?: 'stream' | 'context-command' | 'sdk-get-context-usage' | 'merged';
}
