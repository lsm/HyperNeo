import type { DaemonServerContext } from './daemon-server';

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

    daemon.messageHub.joinChannel('session:' + sessionId).catch(() => {});
  });
}
