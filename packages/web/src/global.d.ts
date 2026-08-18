import type { MessageHub } from '@hyperneo/shared';
import type { Signal } from '@preact/signals';
import type { ConnectionManager } from './lib/connection-manager';
import type { AppState } from './lib/state';
import type { GlobalStore } from './lib/global-store';
import type { SessionStore } from './lib/session-store';

declare global {
  interface Window {
    __messageHub?: MessageHub;
    __messageHubReady?: boolean;

    appState?: typeof AppState;

    connectionManager?: ConnectionManager;

    currentSessionIdSignal?: Signal<string | null>;

    slashCommandsSignal?: Signal<string[]>;

    globalStore?: GlobalStore;
    sessionStore?: SessionStore;
  }
}

export {};
