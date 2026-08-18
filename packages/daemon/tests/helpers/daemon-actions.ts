import type { DaemonServerContext } from './daemon-server';
import type { MessageDeliveryMode } from '@hyperneo/shared';

export async function sendMessage(
  daemon: DaemonServerContext,
  sessionId: string,
  content: string,
  options: {
    images?: Array<{ type: string; source: { type: string; data: string } }>;
    deliveryMode?: MessageDeliveryMode;
  } = {}
): Promise<{ messageId: string }> {
  const baselineMessageCount = await getMessageCount(daemon, sessionId);

  const result = (await daemon.messageHub.request('message.send', {
    sessionId,
    content,
    ...options,
  })) as { messageId: string };

  const isFastMockMode =
    process.env.HYPERNEO_USE_DEV_PROXY === '1' || process.env.HYPERNEO_AGENT_SDK_MOCK === '1';
  const maxStartWaitMs = isFastMockMode ? 1200 : 5000;
  const pollIntervalMs = isFastMockMode ? 20 : 10;
  const start = Date.now();
  while (Date.now() - start < maxStartWaitMs) {
    try {
      const state = await getProcessingState(daemon, sessionId);
      if (state.status !== 'idle' && state.status !== 'unknown') {
        break;
      }

      if (baselineMessageCount !== null) {
        const currentCount = await getMessageCount(daemon, sessionId);
        if (currentCount !== null && currentCount > baselineMessageCount + 1) {
          break;
        }
      }
    } catch {
      // Ignore transient RPC failures while query bootstraps
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return result;
}

async function waitForProcessingState(
  daemon: DaemonServerContext,
  sessionId: string,
  targetStatus: string,
  timeout = 30000
): Promise<void> {
  const currentState = await getProcessingState(daemon, sessionId);
  if (currentState.status === targetStatus) {
    return;
  }

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let resolved = false;
    let poller: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (poller) clearInterval(poller);
        unsubscribe?.();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timeout waiting for processing state "${targetStatus}" after ${timeout}ms`)
      );
    }, timeout);

    unsubscribe = daemon.messageHub.onEvent('state.session', (data: unknown) => {
      if (resolved) return;
      const state = data as {
        sessionInfo?: { id?: string };
        agentState?: { status: string };
      };
      if (state.sessionInfo?.id !== sessionId) return;
      const currentStatus = state.agentState?.status;

      if (currentStatus === targetStatus) {
        cleanup();
        resolve();
      }
    });

    poller = setInterval(async () => {
      if (resolved) return;
      try {
        const state = await getProcessingState(daemon, sessionId);
        if (state.status === targetStatus) {
          cleanup();
          resolve();
        }
      } catch {
        // Ignore polling errors
      }
    }, 50);

    (async () => {
      try {
        await daemon.messageHub.joinChannel('session:' + sessionId);
      } catch {
        // Join failed, polling fallback will still work
      }
      if (!resolved) {
        try {
          const state = await getProcessingState(daemon, sessionId);
          if (state.status === targetStatus) {
            cleanup();
            resolve();
          }
        } catch {
          // Ignore errors, polling will retry
        }
      }
    })();
  });
}

const SDK_STARTUP_TIMEOUT_DEFAULT_MS = 30000;
const IDLE_WAIT_SETTLE_MARGIN_MS = 10000;

function minimumIdleWaitMs(): number {
  const raw = Number.parseInt(process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS ?? '', 10);
  const startupBoundMs = Number.isFinite(raw) && raw > 0 ? raw : SDK_STARTUP_TIMEOUT_DEFAULT_MS;
  return startupBoundMs + IDLE_WAIT_SETTLE_MARGIN_MS;
}

export async function waitForIdle(
  daemon: DaemonServerContext,
  sessionId: string,
  timeout = 90000
): Promise<void> {
  return waitForProcessingState(daemon, sessionId, 'idle', Math.max(timeout, minimumIdleWaitMs()));
}

export async function getProcessingState(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<{ status: string; phase?: string }> {
  const result = (await daemon.messageHub.request('agent.getState', {
    sessionId,
  })) as { state: { status: string; phase?: string } } | undefined;

  if (!result?.state) {
    return { status: 'unknown' };
  }

  return result.state;
}

export async function getSession(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<Record<string, unknown>> {
  const result = (await daemon.messageHub.request('session.get', {
    sessionId,
  })) as { session: Record<string, unknown> } | undefined;

  if (!result?.session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return result.session;
}

async function getMessageCount(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<number | null> {
  try {
    const result = (await daemon.messageHub.request('message.count', {
      sessionId,
    })) as { count?: number } | undefined;
    return typeof result?.count === 'number' ? result.count : null;
  } catch {
    return null;
  }
}

export async function interrupt(daemon: DaemonServerContext, sessionId: string): Promise<void> {
  await daemon.messageHub.request('client.interrupt', { sessionId });
}

export async function waitForSdkMessages(
  daemon: DaemonServerContext,
  sessionId: string,
  options: { minCount?: number; timeout?: number } = {}
): Promise<{ sdkMessages: Array<Record<string, unknown>>; hasMore: boolean }> {
  const { minCount = 1, timeout = 5000 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const result = (await daemon.messageHub.request('message.sdkMessages', {
      sessionId,
    })) as { sdkMessages: Array<Record<string, unknown>>; hasMore: boolean };

    if (result.sdkMessages.length >= minCount) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return (await daemon.messageHub.request('message.sdkMessages', {
    sessionId,
  })) as { sdkMessages: Array<Record<string, unknown>>; hasMore: boolean };
}
