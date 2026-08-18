import { effect } from '@preact/signals';
import { connectionState } from './state';
import { toast } from './toast';
import { sanitizeUserError } from './user-error';

export interface QueuedAction {
  id: string;
  label: string;
  execute: () => Promise<void>;
  queuedAt: number;
  status: 'pending' | 'sent' | 'failed';
  error?: string;
}

let queue: QueuedAction[] = [];
let idCounter = 0;
let flushInProgress = false;

export async function enqueueAction(
  label: string,
  execute: () => Promise<void>,
  options?: { executeImmediately?: boolean }
): Promise<QueuedAction | undefined> {
  const isConnected = connectionState.value === 'connected';

  if (isConnected && options?.executeImmediately !== false) {
    try {
      await execute();
      return undefined;
    } catch (err) {
      if (connectionState.value !== 'connected') {
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

export function getQueuedActions(): readonly QueuedAction[] {
  return queue;
}

export function cancelAction(actionId: string): void {
  queue = queue.filter((a) => a.id !== actionId);
}

export function clearQueue(): void {
  queue = [];
}

export async function flushQueue(): Promise<void> {
  if (flushInProgress) return;
  if (connectionState.value !== 'connected') return;

  const pending = queue.filter((a) => a.status === 'pending');
  if (pending.length === 0) return;

  flushInProgress = true;

  for (const action of pending) {
    if (connectionState.value !== 'connected') break;

    try {
      await action.execute();
      action.status = 'sent';
    } catch (err) {
      if (connectionState.value !== 'connected') break;

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
    toast.warning(`${failures.length} action(s) could not be delivered.`);
  }
}

let cleanupAutoFlush: (() => void) | null = null;

export function startAutoFlush(): void {
  if (cleanupAutoFlush) return;

  cleanupAutoFlush = effect(() => {
    if (connectionState.value === 'connected' && queue.some((a) => a.status === 'pending')) {
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

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (cleanupAutoFlush) {
      cleanupAutoFlush();
      cleanupAutoFlush = null;
    }
  });
}

export function resetQueue(): void {
  queue = [];
  idCounter = 0;
  flushInProgress = false;
}
