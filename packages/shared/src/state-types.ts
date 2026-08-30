import type { AuthStatus, SessionInfo, HealthStatus, HyperNeoActionMessage } from './types.ts';
import type { SDKMessage } from './sdk/sdk.d.ts';
import type { GlobalSettings } from './types/settings.ts';

export type ChatMessage = SDKMessage | HyperNeoActionMessage;

export interface SessionsState {
  sessions: SessionInfo[];
  hasArchivedSessions: boolean;
  timestamp: number;
}

export type ApiConnectionStatus = 'connected' | 'degraded' | 'disconnected';

export interface ApiConnectionState {
  status: ApiConnectionStatus;
  errorCount?: number;
  lastError?: string;
  lastSuccessfulCall?: number;
  timestamp: number;
}

export interface SystemState {
  version: string;
  claudeSDKVersion: string;

  defaultModel: string;
  maxSessions: number;
  storageLocation: string;
  workspaceRoot?: string;

  auth: AuthStatus;

  health: HealthStatus;

  apiConnection: ApiConnectionState;

  credentialStore: CredentialStoreStatus;

  timestamp: number;
}

export type CredentialStoreBackend =
  | 'keychain'
  | 'keychain-unavailable'
  | 'keychain-fallback'
  | 'database';

export interface CredentialStoreStatus {
  backend: CredentialStoreBackend;
  keychainAvailable: boolean;
  warning?: string;
}

export interface SettingsState {
  settings: GlobalSettings;
  timestamp: number;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingUserQuestion {
  toolUseId: string;
  questions: UserQuestion[];
  askedAt: number;
  draftResponses?: QuestionDraftResponse[];
}

export interface QuestionDraftResponse {
  questionIndex: number;
  selectedLabels: string[];
  customText?: string;
}

export type QuestionCancelReason = 'user_cancelled' | 'agent_session_terminated';

export interface ResolvedQuestion {
  question: PendingUserQuestion;
  state: 'submitted' | 'cancelled';
  responses: QuestionDraftResponse[];
  resolvedAt: number;
  cancelReason?: QuestionCancelReason;
}

export type AgentProcessingState =
  | { status: 'idle' }
  | { status: 'queued'; messageId: string }
  | {
      status: 'processing';
      messageId: string;
      phase: 'initializing' | 'thinking' | 'streaming' | 'finalizing';
      streamingStartedAt?: number;
      isCompacting?: boolean;
    }
  | { status: 'waiting_for_input'; pendingQuestion: PendingUserQuestion }
  | {
      status: 'rate_limit_cooldown';
      retryCount: number;
      maxRetries: number;
      retryAt: number;
      messageId?: string;
    }
  | { status: 'interrupted' };

export interface CommandsData {
  availableCommands: string[];
}

export interface SessionError {
  message: string;
  details?: unknown;
  occurredAt: number;
}

export interface SessionState {
  sessionInfo: SessionInfo | null;

  agentState: AgentProcessingState;

  commandsData: CommandsData;

  error: SessionError | null;

  timestamp: number;

  revision?: number;

  daemonEpoch?: string;
}

export interface SDKMessagesState {
  sdkMessages: ChatMessage[];
  hasMore: boolean;
  timestamp: number;
}

export interface StateChannelMeta {
  channel: string;
  sessionId: string;
  lastUpdate: number;
  version: number;
}

export interface GlobalStateSnapshot {
  sessions: SessionsState;
  system: SystemState;
  settings: SettingsState;
  meta: StateChannelMeta;
}

export interface SessionStateSnapshot {
  session: SessionState;
  sdkMessages: SDKMessagesState;
  meta: StateChannelMeta;
}

export interface SessionsUpdate {
  added?: SessionInfo[];
  updated?: SessionInfo[];
  removed?: string[];
  timestamp: number;
}

export interface SDKMessagesUpdate {
  added?: ChatMessage[];
  timestamp: number;
}

export const STATE_CHANNELS = {
  GLOBAL_SESSIONS: 'state.sessions',
  GLOBAL_SYSTEM: 'state.system',
  GLOBAL_SETTINGS: 'state.settings',
  GLOBAL_SNAPSHOT: 'state.global.snapshot',

  SESSION: 'state.session',
  SESSION_SDK_MESSAGES: 'state.sdkMessages',
  SESSION_SNAPSHOT: 'state.session.snapshot',
} as const;

export type StateChangeEvent<T> = {
  type: 'full' | 'partial' | 'delta';
  data: T;
  timestamp: number;
  version: number;
};
