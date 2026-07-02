/**
 * State Types for Client-Server Synchronization
 *
 * Fine-grained state channels - each property has its own channel
 */

import type { AuthStatus, SessionInfo, HealthStatus, NeokaiActionMessage } from './types.ts';
import type { SDKMessage } from './sdk/sdk.d.ts';
import type { GlobalSettings } from './types/settings.ts';

/** A message in the chat list — either a native SDK message or a HyperNeo action prompt. */
export type ChatMessage = SDKMessage | NeokaiActionMessage;

/**
 * Global State Channels
 * These are available to all clients and use sessionId: "global"
 */

// State channel: global:state.sessions
export interface SessionsState {
  sessions: SessionInfo[];
  hasArchivedSessions: boolean; // Whether there are any archived sessions in the database
  timestamp: number;
}

/**
 * API Connection Status
 * Tracks connectivity between daemon and Claude API (not WebSocket)
 */
export type ApiConnectionStatus = 'connected' | 'degraded' | 'disconnected';

export interface ApiConnectionState {
  status: ApiConnectionStatus;
  /** Number of consecutive connection errors in current window */
  errorCount?: number;
  /** Last connection error message */
  lastError?: string;
  /** Timestamp of last successful API call */
  lastSuccessfulCall?: number;
  timestamp: number;
}

// State channel: global:state.system (UNIFIED)
// Combines auth, config, and health into single channel
export interface SystemState {
  // Version & build info
  version: string;
  claudeSDKVersion: string;

  // Configuration
  defaultModel: string;
  maxSessions: number;
  storageLocation: string;
  workspaceRoot?: string;

  // Authentication
  auth: AuthStatus;

  // System health
  health: HealthStatus;

  // API connectivity (daemon <-> Claude API)
  apiConnection: ApiConnectionState;

  /**
   * Provider credential store status. Surfaced so the UI can warn the user
   * when macOS Keychain persistence is unavailable (e.g. daemon launched over
   * SSH or in CI without GUI session access).
   */
  credentialStore: CredentialStoreStatus;

  timestamp: number;
}

/**
 * Status of the provider credential store.
 *
 * - `keychain`              — macOS Keychain is in use.
 * - `keychain-unavailable`  — macOS Keychain is locked/unavailable and no
 *   fallback credential store is configured; writes cannot proceed.
 * - `keychain-fallback`     — macOS Keychain locked/unavailable; daemon is
 *   using the local encrypted `DatabaseCredentialStore` instead. Writes
 *   succeed but with weaker isolation than the Keychain.
 * - `database`              — non-darwin platform or test env; Keychain not in use.
 */
export type CredentialStoreBackend =
  | 'keychain'
  | 'keychain-unavailable'
  | 'keychain-fallback'
  | 'database';

export interface CredentialStoreStatus {
  backend: CredentialStoreBackend;
  /** True when the macOS Keychain is currently usable. */
  keychainAvailable: boolean;
  /** Human-readable hint shown to the user when `keychainAvailable` is false on macOS. */
  warning?: string;
}

// State channel: global:state.settings
export interface SettingsState {
  settings: GlobalSettings;
  timestamp: number;
}

/**
 * Session-Specific State Channels
 * These use sessionId: <session-id> for routing
 */

/**
 * Question option for AskUserQuestion tool
 */
export interface QuestionOption {
  label: string;
  description: string;
}

/**
 * Question from AskUserQuestion tool
 */
export interface UserQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * Pending user question from AskUserQuestion tool
 * When agent calls AskUserQuestion, this is populated and processing pauses
 */
export interface PendingUserQuestion {
  /** Tool use ID - needed to send response as tool_result */
  toolUseId: string;
  /** The questions from AskUserQuestion input */
  questions: UserQuestion[];
  /** When the question was asked */
  askedAt: number;
  /** Draft responses (saved as user interacts, before submit) */
  draftResponses?: QuestionDraftResponse[];
}

/**
 * Draft response for a question (saved before final submit)
 */
export interface QuestionDraftResponse {
  questionIndex: number;
  selectedLabels: string[];
  customText?: string;
}

/**
 * Reason a question was cancelled.
 * - `user_cancelled`: user clicked Skip in the UI
 * - `agent_session_terminated`: agent session ended before the user answered
 *   (force-completion, rehydrate failure, daemon shutdown). UI should render
 *   the card distinctly so the user understands why the question went away.
 */
export type QuestionCancelReason = 'user_cancelled' | 'agent_session_terminated';

/**
 * Resolved question - saved after user submits or cancels
 * Used to persist question UI state across page refreshes
 */
export interface ResolvedQuestion {
  /** The original question data */
  question: PendingUserQuestion;
  /** How the question was resolved */
  state: 'submitted' | 'cancelled';
  /** User's responses (empty for cancelled) */
  responses: QuestionDraftResponse[];
  /** When the question was resolved */
  resolvedAt: number;
  /**
   * When `state === 'cancelled'`, explains who/what cancelled the question.
   *
   * Optional and unset on records persisted before this field was added —
   * the field has no runtime default. Renderers that need a fallback
   * (e.g. `QuestionPrompt`) must handle `undefined` explicitly; the
   * current UI displays a generic "Question skipped" header for missing
   * `cancelReason` and a specific "agent session ended" header for
   * `cancelReason === 'agent_session_terminated'`.
   */
  cancelReason?: QuestionCancelReason;
}

/**
 * Agent processing state
 * Tracks what the agent is currently doing with fine-grained phase information
 * Moved from daemon/agent-session.ts to shared for type consistency
 */
export type AgentProcessingState =
  | { status: 'idle' }
  | { status: 'queued'; messageId: string }
  | {
      status: 'processing';
      messageId: string;
      phase: 'initializing' | 'thinking' | 'streaming' | 'finalizing';
      streamingStartedAt?: number; // Timestamp when streaming began
      isCompacting?: boolean; // True during context compaction
    }
  | { status: 'waiting_for_input'; pendingQuestion: PendingUserQuestion }
  | {
      status: 'rate_limit_cooldown';
      retryCount: number;
      maxRetries: number;
      retryAt: number;
    }
  | { status: 'interrupted' };

/**
 * Commands data structure
 */
export interface CommandsData {
  availableCommands: string[];
}

/**
 * Session error state
 * Folded from separate session.error event into unified state.session
 */
export interface SessionError {
  message: string;
  details?: unknown; // StructuredError when available
  occurredAt: number;
}

/**
 * UNIFIED Session State
 * Combines all session-specific state (metadata, agent, commands, context)
 * into a single state channel for simpler synchronization
 *
 * State channel: {sessionId}:state.session
 *
 * This replaces the old fragmented approach of:
 * - state.session (metadata only)
 * - agent.state event (agent state)
 * - session.commands-updated event (commands)
 * - state.context (context info)
 */
export interface SessionState {
  // Session metadata (null in error states when session doesn't exist)
  sessionInfo: SessionInfo | null;

  // Agent processing state
  agentState: AgentProcessingState;

  // Available slash commands
  commandsData: CommandsData;

  // Error state (folded from session.error event)
  error: SessionError | null;

  timestamp: number;
}

// State channel: {sessionId}:state.sdkMessages
export interface SDKMessagesState {
  sdkMessages: ChatMessage[];
  hasMore: boolean;
  timestamp: number;
}

/**
 * State Channel Metadata
 */
export interface StateChannelMeta {
  channel: string;
  sessionId: string;
  lastUpdate: number;
  version: number; // For conflict resolution
}

/**
 * State Snapshot - Full state for initial sync
 */
export interface GlobalStateSnapshot {
  sessions: SessionsState;
  system: SystemState;
  settings: SettingsState;
  meta: StateChannelMeta;
}

export interface SessionStateSnapshot {
  // Unified session state (metadata, agent, commands, context)
  session: SessionState;
  // SDK messages (kept separate due to different update pattern)
  sdkMessages: SDKMessagesState;
  meta: StateChannelMeta;
}

/**
 * State Update Events
 * Incremental updates for specific channels
 */

// For array updates, we can send deltas
export interface SessionsUpdate {
  added?: SessionInfo[];
  updated?: SessionInfo[];
  removed?: string[]; // session IDs
  timestamp: number;
}

export interface SDKMessagesUpdate {
  added?: ChatMessage[];
  timestamp: number;
}

/**
 * State Channel Names
 * Centralized channel name constants
 */
export const STATE_CHANNELS = {
  // Global channels
  GLOBAL_SESSIONS: 'state.sessions',
  GLOBAL_SYSTEM: 'state.system', // Unified system state (auth + config + health)
  GLOBAL_SETTINGS: 'state.settings', // Global settings state
  GLOBAL_SNAPSHOT: 'state.global.snapshot',

  // Session channels (prefix with sessionId:)
  SESSION: 'state.session', // Unified session state (metadata + agent + commands + context)
  SESSION_SDK_MESSAGES: 'state.sdkMessages',
  SESSION_SNAPSHOT: 'state.session.snapshot',
} as const;

/**
 * State change event types
 */
export type StateChangeEvent<T> = {
  type: 'full' | 'partial' | 'delta';
  data: T;
  timestamp: number;
  version: number;
};
