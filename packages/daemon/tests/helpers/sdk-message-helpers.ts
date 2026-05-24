/**
 * SDK Message Helpers
 *
 * Shared helpers for observing SDK messages (system:init, etc.) in online tests.
 */

import type { DaemonServerContext } from './daemon-server';

/**
 * Wait for the next system:init SDK message on a session channel.
 * Must be called BEFORE the action that triggers a new query turn.
 */
export function waitForSystemInit(
  daemon: DaemonServerContext,
  sessionId: string,
  timeout = 30000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        unsubscribe?.();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for system:init message after ${timeout}ms`));
    }, timeout);

    // Subscribe FIRST so no events are missed once the channel is joined
    unsubscribe = daemon.messageHub.onEvent('state.sdkMessages.delta', (data: unknown) => {
      if (resolved) return;
      const delta = data as { added?: Array<Record<string, unknown>> };
      for (const msg of delta.added ?? []) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          cleanup();
          resolve(msg);
          return;
        }
      }
    });

    // Join the session channel (idempotent — safe to call multiple times)
    daemon.messageHub.joinChannel('session:' + sessionId).catch(() => {});
  });
}
