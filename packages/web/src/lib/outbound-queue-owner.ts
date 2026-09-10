import type { QueuedAction } from './outbound-queue';
import { sanitizeUserError } from './user-error';

interface OutboundQueueDependencies {
  isConnected(): boolean;
  observeConnection(callback: () => void): () => void;
  warn(message: string): void;
}

export function createOutboundQueue(deps: OutboundQueueDependencies) {
  let queue: QueuedAction[] = [];
  let idCounter = 0;
  let flushInProgress = false;

  async function enqueueAction(
    label: string,
    execute: () => Promise<void>,
    options?: { executeImmediately?: boolean }
  ): Promise<QueuedAction | undefined> {
    const isConnected = deps.isConnected();

    if (isConnected && options?.executeImmediately !== false) {
      try {
        await execute();
        return undefined;
      } catch (err) {
        if (!deps.isConnected()) {
          return enqueueInternal(label, execute);
        }
        throw err;
      }
    }

    const action = enqueueInternal(label, execute);

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

  function getQueuedActions(): readonly QueuedAction[] {
    return queue;
  }

  function cancelAction(actionId: string): void {
    queue = queue.filter((a) => a.id !== actionId);
  }

  function clearQueue(): void {
    queue = [];
  }

  async function flushQueue(): Promise<void> {
    if (flushInProgress) return;
    if (!deps.isConnected()) return;

    const pending = queue.filter((a) => a.status === 'pending');
    if (pending.length === 0) return;

    flushInProgress = true;

    for (const action of pending) {
      if (!deps.isConnected()) break;

      try {
        await action.execute();
        action.status = 'sent';
      } catch (err) {
        if (!deps.isConnected()) break;

        action.status = 'failed';
        action.error = sanitizeUserError(err);
      }
    }

    flushInProgress = false;

    setTimeout(() => {
      queue = queue.filter((a) => a.status !== 'sent');
    }, 2000);

    const failures = queue.filter((a) => a.status === 'failed');
    if (failures.length > 0) {
      deps.warn(`${failures.length} action(s) could not be delivered.`);
    }
  }

  let cleanupAutoFlush: (() => void) | null = null;

  function startAutoFlush(): void {
    if (cleanupAutoFlush) return;

    cleanupAutoFlush = deps.observeConnection(() => {
      if (deps.isConnected() && queue.some((a) => a.status === 'pending')) {
        setTimeout(() => flushQueue(), 500);
      }
    });
  }

  function stopAutoFlush(): void {
    if (cleanupAutoFlush) {
      cleanupAutoFlush();
      cleanupAutoFlush = null;
    }
  }

  function resetQueue(): void {
    queue = [];
    idCounter = 0;
    flushInProgress = false;
  }

  return {
    enqueueAction,
    getQueuedActions,
    cancelAction,
    clearQueue,
    flushQueue,
    startAutoFlush,
    stopAutoFlush,
    resetQueue,
  };
}
