import type { MessageHub } from '@hyperneo/shared/message-hub/message-hub';
import type { Session, ContextInfo, AgentProcessingState } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { ConnectionState } from '@hyperneo/shared/message-hub/types';
import type { Signal } from '@preact/signals';

interface SessionStore {
  activeSessionId: Signal<string | null>;

  sessionState: Signal<{
    sessionInfo?: Session;
    agentState?: AgentProcessingState;
    contextInfo?: ContextInfo | null;
    commandsData?: { availableCommands?: string[] } | null;
    error?: { message: string; details?: unknown; occurredAt: number } | null;
  } | null>;

  sdkMessages: Signal<SDKMessage[]>;

  agentState: Signal<AgentProcessingState>;

  contextInfo: Signal<ContextInfo | null>;

  commandsData: Signal<string[]>;

  error: Signal<{
    message: string;
    details?: unknown;
    occurredAt: number;
  } | null>;
}

interface GlobalStore {
  sessions: Signal<Session[]>;

  hasArchivedSessions: Signal<boolean>;

  systemState: Signal<{
    auth?: unknown;
    health?: unknown;
    apiConnection?: unknown;
  } | null>;

  settings: Signal<unknown | null>;
}

interface AppState {
  messageHub?: MessageHub;
}

interface TestMessageHub {
  getState(): ConnectionState;
  subscribe<T = unknown>(
    event: string,
    handler: (data: T) => void | Promise<void>,
    options?: { sessionId?: string }
  ): Promise<() => Promise<void>>;
  request<TResult = unknown>(
    method: string,
    data?: unknown,
    options?: { sessionId?: string; timeout?: number }
  ): Promise<TResult>;
}

declare global {
  interface Window {
    __messageHub?: TestMessageHub;

    appState?: AppState;

    currentSessionIdSignal?: Signal<string | null>;

    globalStore?: GlobalStore;

    sessionStore?: SessionStore;
  }
}

export {};
