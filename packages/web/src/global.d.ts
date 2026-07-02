/**
 * Global type augmentations for the web package
 */

import type { MessageHub } from '@hyperneo/shared';
import type { Signal } from '@preact/signals';
import type { ConnectionManager } from './lib/connection-manager';
import type { AppState } from './lib/state';
import type { GlobalStore } from './lib/global-store';
import type { SessionStore } from './lib/session-store';

declare global {
  interface Window {
    // MessageHub exposed for testing/debugging
    __messageHub?: MessageHub;
    __messageHubReady?: boolean;

    // App state exposed for testing/debugging
    appState?: typeof AppState;

    // Connection manager exposed for testing
    connectionManager?: ConnectionManager;

    // Current session ID signal for testing
    currentSessionIdSignal?: Signal<string | null>;

    // Slash commands signal for testing
    slashCommandsSignal?: Signal<string[]>;

    // Stores exposed for testing
    globalStore?: GlobalStore;
    sessionStore?: SessionStore;
  }
}

export {};
