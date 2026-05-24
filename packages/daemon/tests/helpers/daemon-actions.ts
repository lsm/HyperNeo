/**
 * Helper utilities for online daemon tests
 *
 * These helpers provide convenient patterns for:
 * - Sending messages via RPC
 * - Waiting for state changes via subscriptions
 * - Observing agent behavior through events
 */

import type { DaemonServerContext } from './daemon-server';
import type { MessageDeliveryMode } from '@neokai/shared';

/**
 * Send a message via RPC and return the messageId
 */
export async function sendMessage(
  daemon: DaemonServerContext,
  sessionId: string,
  content: string,
  options: {
    images?: Array<{ type: string; source: { type: string; data: string } }>;
    deliveryMode?: MessageDeliveryMode;
  } = {}
): Promise<{ messageId: string }> {
  // Capture baseline count so we can detect post-send progress even when
  // state flips back to idle too quickly in mocked/proxy mode.
  const baselineMessageCount = await getMessageCount(daemon, sessionId);

  const result = (await daemon.messageHub.request('message.send', {
    sessionId,
    content,
    ...options,
  })) as { messageId: string };

  // message.send acknowledges persistence, not query start.
  // Wait briefly for agent to leave idle so downstream waitForIdle() calls don't
  // resolve against the pre-send idle state. In fast mock/proxy mode, state can
  // return to idle before we sample it, so also detect SDK message growth.
  const isFastMockMode =
    process.env.NEOKAI_USE_DEV_PROXY === '1' || process.env.NEOKAI_AGENT_SDK_MOCK === '1';
  const maxStartWaitMs = isFastMockMode ? 1200 : 5000;
  const pollIntervalMs = isFastMockMode ? 20 : 10;
  const start = Date.now();
  while (Date.now() - start < maxStartWaitMs) {
    try {
      const state = await getProcessingState(daemon, sessionId);
      if (state.status !== 'idle' && state.status !== 'unknown') {
        break;
      }

      // If we can observe additional SDK messages beyond the newly persisted
      // user message, processing has started/completed for this turn.
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

/**
 * Wait for the agent to reach a specific processing state
 *
 * Uses state.session subscription to monitor agent state changes.
 * Also checks the current state first to handle the case where
 * processing completes before the subscription is set up.
 *
 * NOTE: The state structure uses 'agentState' (not 'processingState').
 * See SessionState interface in @neokai/shared/src/state-types.ts
 */

async function waitForProcessingState(
  daemon: DaemonServerContext,
  sessionId: string,
  targetStatus: string,
  timeout = 30000
): Promise<void> {
  // First check if we're already in the target state
  // This handles the race condition where processing completes before subscription
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

    // Set up timeout
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timeout waiting for processing state "${targetStatus}" after ${timeout}ms`)
      );
    }, timeout);

    // Subscribe to events FIRST to ensure no events are missed once room is joined.
    // Filter by sessionId: the client may have joined channels from prior test sessions,
    // so events from those channels must not trigger resolution for the wrong session.
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

    // Polling fallback: re-check state periodically in case events are missed.
    // This closes any remaining race windows regardless of event delivery.
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

    // Join room, then re-check state to close the primary race window.
    // The re-check AFTER joinRoom ensures: if state changed before join completed,
    // we catch it. If it changes after, the event handler catches it.
    (async () => {
      try {
        await daemon.messageHub.joinChannel('session:' + sessionId);
      } catch {
        // Join failed, polling fallback will still work
      }
      // Re-check after room join completes
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

/**
 * Wait for the agent to reach idle state
 */
export async function waitForIdle(
  daemon: DaemonServerContext,
  sessionId: string,
  timeout = 90000
): Promise<void> {
  return waitForProcessingState(daemon, sessionId, 'idle', timeout);
}

/**
 * Collect SDK messages from the session via subscription
 *
 * Returns an async generator that yields SDK messages as they arrive.
 */

/**
 * Get current processing state via RPC
 */
export async function getProcessingState(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<{ status: string; phase?: string }> {
  const result = (await daemon.messageHub.request('agent.getState', {
    sessionId,
  })) as { state: { status: string; phase?: string } } | undefined;

  if (!result?.state) {
    // Return a default state if RPC fails or returns unexpected data
    return { status: 'unknown' };
  }

  return result.state;
}

/**
 * Get session data via RPC
 */
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

/**
 * Get total SDK message count for a session
 */
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

/**
 * List all sessions via RPC
 */

/**
 * Delete a session via RPC
 */

/**
 * Interrupt the current processing via RPC
 */
export async function interrupt(daemon: DaemonServerContext, sessionId: string): Promise<void> {
  await daemon.messageHub.request('client.interrupt', { sessionId });
}

/**
 * Wait for SDK messages to be available (handles persistence race)
 *
 * After waitForIdle() returns, SDK messages may not yet be fully
 * persisted to the database. This helper retries the query until
 * the expected number of messages appear.
 */
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

  // Return whatever we have on timeout (let the test assertion fail with useful context)
  return (await daemon.messageHub.request('message.sdkMessages', {
    sessionId,
  })) as { sdkMessages: Array<Record<string, unknown>>; hasMore: boolean };
}
