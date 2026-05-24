/**
 * Global type declarations for E2E tests
 *
 * This file provides proper Window augmentation to avoid (window as any) casts.
 * All window properties exposed by the web app for testing should be declared here.
 */

import type { MessageHub } from '@neokai/shared/message-hub/message-hub';
import type { Session, ContextInfo, AgentProcessingState } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import type { ConnectionState } from '@neokai/shared/message-hub/types';
import type { Signal } from '@preact/signals';

/**
 * SessionStore interface (simplified for E2E tests)
 *
 * The SessionStore has both signals and computed properties.
 * - Core signals: activeSessionId, sessionState, sdkMessages
 * - Computed properties (also signals): agentState, contextInfo, commandsData, error
 */
interface SessionStore {
  // ========================================
  // Core Signals
  // ========================================

  /** Current active session ID (signal) */
  activeSessionId: Signal<string | null>;

  /** Unified session state from state.session channel (signal) */
  sessionState: Signal<{
    sessionInfo?: Session;
    agentState?: AgentProcessingState;
    contextInfo?: ContextInfo | null;
    commandsData?: { availableCommands?: string[] } | null;
    error?: { message: string; details?: unknown; occurredAt: number } | null;
  } | null>;

  /** SDK messages from state.sdkMessages channel (signal) */
  sdkMessages: Signal<SDKMessage[]>;

  // ========================================
  // Computed Properties (Signals)
  // ========================================

  /** Agent processing state (computed signal, returns { status: 'idle' } as default) */
  agentState: Signal<AgentProcessingState>;

  /** Context info (computed signal) */
  contextInfo: Signal<ContextInfo | null>;

  /** Available slash commands (computed signal, returns string[] directly) */
  commandsData: Signal<string[]>;

  /** Session error state (computed signal) */
  error: Signal<{
    message: string;
    details?: unknown;
    occurredAt: number;
  } | null>;
}

/**
 * GlobalStore interface (simplified for E2E tests)
 */
interface GlobalStore {
  /** All sessions (signal) */
  sessions: Signal<Session[]>;

  /** Whether there are any archived sessions in the database (signal) */
  hasArchivedSessions: Signal<boolean>;

  /** Unified system state (signal) */
  systemState: Signal<{
    auth?: unknown;
    health?: unknown;
    apiConnection?: unknown;
  } | null>;

  /** Global settings (signal) */
  settings: Signal<unknown | null>;
}

/**
 * Global application state exposed on window
 */
interface AppState {
  messageHub?: MessageHub;
}

/**
 * MessageHub-like interface for E2E tests (subset of actual MessageHub)
 */
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

/**
 * Window augmentation for E2E tests
 *
 * These properties are exposed by the web app for testing purposes.
 * Using this declaration avoids (window as any) casts throughout tests.
 */
declare global {
  interface Window {
    /** MessageHub instance for direct RPC/event access in tests */
    __messageHub?: TestMessageHub;

    /** Application state for observing signals */
    appState?: AppState;

    /** Current session ID signal (if exposed globally) */
    currentSessionIdSignal?: Signal<string | null>;

    /** GlobalStore for sessions list */
    globalStore?: GlobalStore;

    /** SessionStore for current session state */
    sessionStore?: SessionStore;
  }
}

export {};
