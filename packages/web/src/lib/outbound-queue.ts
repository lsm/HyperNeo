/**
 * Outbound Action Queue
 *
 * Queues user actions (messages, RPC calls) when the WebSocket is disconnected.
 * Automatically flushes the queue once reconnection succeeds.
 *
 * This ensures users don't lose typed messages or actions during transient
 * network blips — a pattern familiar from chat apps like WhatsApp/Signal.
 */

import { effect } from '@preact/signals';
import { connectionState } from './state';
import { toast } from './toast';
import { sanitizeUserError } from './user-error';

export interface QueuedAction {
  /** Unique ID for this queued action */
  id: string;
  /** Human-readable label shown in UI ("Message: Hello…") */
  label: string;
  /** The async operation to execute */
  execute: () => Promise<void>;
  /** Timestamp when queued */
  queuedAt: number;
  /** Status: pending, sent, failed */
  status: 'pending' | 'sent' | 'failed';
  /** Error message if failed */
  error?: string;
}

let queue: QueuedAction[] = [];
let idCounter = 0;
let flushInProgress = false;

/**
 * Add an action to the outbound queue.
 *
 * If connected, executes immediately. Otherwise, queues for later.
 * Returns the queued action (or undefined if executed immediately).
 */
export async function enqueueAction(
  label: string,
  execute: () => Promise<void>,
  options?: { executeImmediately?: boolean }
): Promise<QueuedAction | undefined> {
  const isConnected = connectionState.value === 'connected';

  // If connected and caller wants immediate execution, try it
  if (isConnected && options?.executeImmediately !== false) {
    try {
      await execute();
      return undefined;
    } catch (err) {
      // If the connection dropped during execution, queue it
      if (connectionState.value !== 'connected') {
        return enqueueInternal(label, execute);
      }
      // Otherwise, it's a real error — rethrow
      throw err;
    }
  }

  // Not connected (or forced queue) — queue for later
  const action = enqueueInternal(label, execute);

  // When connected but forced to queue (executeImmediately: false),
  // the auto-flush effect won't fire since it only watches connectionState.
  // Schedule a flush so the action isn't stuck pending indefinitely.
  if (isConnected) {
    setTimeout(() => flushQueue(), 500);
  }

  return action;
}

function enqueueInternal(label: string, execute: () => Promise<void>): QueuedAction {
  const action: QueuedAction = {
    id: `queue-${++idCounter}`,
    label,
    execute,
    queuedAt: Date.now(),
    status: 'pending',
  };
  queue.push(action);
  return action;
}

/**
 * Get all queued actions (for UI display)
 */
export function getQueuedActions(): readonly QueuedAction[] {
  return queue;
}

/**
 * Remove an action from the queue (user cancelled)
 */
export function cancelAction(actionId: string): void {
  queue = queue.filter((a) => a.id !== actionId);
}

/**
 * Clear all pending actions
 */
export function clearQueue(): void {
  queue = [];
}

/**
 * Flush all pending actions — called on reconnect.
 *
 * Processes actions sequentially to avoid overwhelming the connection.
 * Failed actions are marked as 'failed' but remain in queue for UI display.
 */
export async function flushQueue(): Promise<void> {
  if (flushInProgress) return;
  if (connectionState.value !== 'connected') return;

  const pending = queue.filter((a) => a.status === 'pending');
  if (pending.length === 0) return;

  flushInProgress = true;

  for (const action of pending) {
    // Abort flush if connection drops mid-flush — leave remaining actions pending
    if (connectionState.value !== 'connected') break;

    try {
      await action.execute();
      action.status = 'sent';
    } catch (err) {
      // If disconnected during execution, stop and leave remaining actions pending
      if (connectionState.value !== 'connected') break;

      action.status = 'failed';
      action.error = sanitizeUserError(err);
    }
  }

  flushInProgress = false;

  // Clean up sent actions after a short delay (so UI can show "sent" state)
  setTimeout(() => {
    queue = queue.filter((a) => a.status !== 'sent');
  }, 2000);

  // Notify about failures
  const failures = queue.filter((a) => a.status === 'failed');
  if (failures.length > 0) {
    toast.warning(`${failures.length} action(s) could not be delivered.`);
  }
}

/**
 * Auto-flush when connection is restored.
 * Sets up a reactive subscription to connection state.
 */
let cleanupAutoFlush: (() => void) | null = null;

export function startAutoFlush(): void {
  if (cleanupAutoFlush) return; // Already started

  cleanupAutoFlush = effect(() => {
    if (connectionState.value === 'connected' && queue.some((a) => a.status === 'pending')) {
      // Small delay to let subscriptions settle
      setTimeout(() => flushQueue(), 500);
    }
  });
}

export function stopAutoFlush(): void {
  if (cleanupAutoFlush) {
    cleanupAutoFlush();
    cleanupAutoFlush = null;
  }
}

// HMR cleanup: tear down the old effect subscription before module re-evaluation
// prevents orphaned subscriptions that fire on every state change
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (cleanupAutoFlush) {
      cleanupAutoFlush();
      cleanupAutoFlush = null;
    }
  });
}

// For testing: reset module state
export function resetQueue(): void {
  queue = [];
  idCounter = 0;
  flushInProgress = false;
}
