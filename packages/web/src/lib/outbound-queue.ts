import { effect } from '@preact/signals';
import { createOutboundQueue } from './outbound-queue-owner';
import { connectionState } from './state';
import { toast } from './toast';

export interface QueuedAction {
  id: string;
  label: string;
  execute: () => Promise<void>;
  queuedAt: number;
  status: 'pending' | 'sent' | 'failed';
  error?: string;
}

export const {
  enqueueAction,
  getQueuedActions,
  cancelAction,
  clearQueue,
  flushQueue,
  startAutoFlush,
  stopAutoFlush,
  resetQueue,
} = createOutboundQueue({
  isConnected: () => connectionState.value === 'connected',
  observeConnection: (callback) => effect(callback),
  warn: (message) => toast.warning(message),
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopAutoFlush());
}
