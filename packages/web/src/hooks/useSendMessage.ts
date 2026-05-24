/**
 * useSendMessage Hook
 *
 * Handles message sending with timeout, validation, and error handling.
 * Extracted from ChatContainer.tsx for better separation of concerns.
 */

import type { MessageDeliveryMode, MessageImage, Session } from '@neokai/shared';
import { useCallback, useRef } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager';
import { enqueueAction } from '../lib/outbound-queue';
import { connectionState } from '../lib/state';
import { toast } from '../lib/toast';
import { sanitizeUserError } from '../lib/user-error';

export interface UseSendMessageOptions {
  sessionId: string;
  session: Session | null;
  isSending: boolean;
  allowQueueWhileProcessing?: boolean;
  onSendStart: () => void;
  onSendComplete: () => void;
  onError: (error: string) => void;
  onMessageAccepted?: (messageId: string) => void;
}

export interface UseSendMessageResult {
  sendMessage: (
    content: string,
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ) => Promise<boolean>;
  clearSendTimeout: () => void;
}

const SEND_TIMEOUT_MS = 15000;

/**
 * Hook for sending messages with proper timeout and error handling
 */
export function useSendMessage({
  sessionId,
  session,
  isSending,
  allowQueueWhileProcessing = false,
  onSendStart,
  onSendComplete,
  onError,
  onMessageAccepted,
}: UseSendMessageOptions): UseSendMessageResult {
  const sendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSendTimeout = useCallback(() => {
    if (sendTimeoutRef.current) {
      clearTimeout(sendTimeoutRef.current);
      sendTimeoutRef.current = null;
    }
  }, []);

  const sendMessage = useCallback(
    async (
      content: string,
      images?: MessageImage[],
      deliveryMode: MessageDeliveryMode = 'immediate'
    ) => {
      if (!content.trim() || (isSending && !allowQueueWhileProcessing)) return false;

      if (session?.status === 'archived') {
        toast.error('Cannot send messages to archived sessions');
        return false;
      }

      const isConnected = connectionState.value === 'connected';
      if (!isConnected) {
        // Queue message for when connection is restored
        const label =
          content.length > 40 ? `Message: ${content.slice(0, 40)}…` : `Message: ${content}`;
        enqueueAction(label, async () => {
          const hub = connectionManager.getHubIfConnected();
          if (!hub) throw new Error('Not connected');
          const payload: {
            sessionId: string;
            content: string;
            images?: MessageImage[];
            deliveryMode?: MessageDeliveryMode;
          } = { sessionId, content, images };
          if (deliveryMode !== 'immediate') {
            payload.deliveryMode = deliveryMode;
          }
          const result = await hub.request<{ messageId?: string }>('message.send', payload);
          if (result?.messageId) onMessageAccepted?.(result.messageId);
        });
        toast.info('Message queued — will send when reconnected.');
        return true;
      }

      try {
        onSendStart();

        sendTimeoutRef.current = setTimeout(() => {
          onSendComplete();
          onError('Message send timed out.');
          toast.error('Message send timed out.');
        }, SEND_TIMEOUT_MS);

        const hub = connectionManager.getHubIfConnected();
        if (!hub) {
          // Hub disappeared during send (race during socket teardown) - queue for retry
          const qLabel =
            content.length > 40 ? `Message: ${content.slice(0, 40)}…` : `Message: ${content}`;
          const qPayload: {
            sessionId: string;
            content: string;
            images?: MessageImage[];
            deliveryMode?: MessageDeliveryMode;
          } = { sessionId, content, images };
          if (deliveryMode !== 'immediate') {
            qPayload.deliveryMode = deliveryMode;
          }
          // Force queue â hub is null so immediate execution would fail
          enqueueAction(
            qLabel,
            async () => {
              const h = connectionManager.getHubIfConnected();
              if (!h) throw new Error('Not connected');
              const res = await h.request<{ messageId?: string }>('message.send', qPayload);
              if (res?.messageId) onMessageAccepted?.(res.messageId);
            },
            { executeImmediately: false }
          );
          toast.info('Message queued — will send when reconnected.');
          onSendComplete();
          clearSendTimeout();
          return true;
        }

        const requestPayload: {
          sessionId: string;
          content: string;
          images?: MessageImage[];
          deliveryMode?: MessageDeliveryMode;
        } = { sessionId, content, images };

        if (deliveryMode !== 'immediate') {
          requestPayload.deliveryMode = deliveryMode;
        }

        const result = await hub.request<{ messageId?: string }>('message.send', requestPayload);
        if (result?.messageId) {
          onMessageAccepted?.(result.messageId);
        }

        // Clear timeout on successful send
        clearSendTimeout();
        return true;
      } catch (err) {
        const message = sanitizeUserError(err);
        onError(message);
        toast.error(message);
        onSendComplete();
        clearSendTimeout();
        return false;
      }
    },
    [
      sessionId,
      session,
      isSending,
      allowQueueWhileProcessing,
      onSendStart,
      onSendComplete,
      onError,
      clearSendTimeout,
      onMessageAccepted,
    ]
  );

  return {
    sendMessage,
    clearSendTimeout,
  };
}
