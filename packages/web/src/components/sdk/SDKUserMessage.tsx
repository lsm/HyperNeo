import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { MessageDeliveryRetryInfo, MessageDeliveryStatus } from '@hyperneo/shared';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { retryMessageDelivery } from '../../lib/api-helpers.ts';
import { useVisibleTick } from '../../hooks/useVisibleTick.ts';
import { toast } from '../../lib/toast.ts';
import { borderRadius, messageColors, messageSpacing } from '../../lib/design-tokens.ts';
import { cn, copyToClipboard } from '../../lib/utils.ts';
import { Dropdown } from '../ui/Dropdown.tsx';
import { DeliveryStateBadge } from '../ui/DeliveryStateBadge.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { Spinner } from '../ui/Spinner.tsx';
import { Tooltip } from '../ui/Tooltip.tsx';
import { ErrorOutput, hasErrorOutput } from './ErrorOutput.tsx';
import { MentionToken, parseTextWithReferences } from './MentionToken.tsx';
import { MessageInfoButton } from './MessageInfoButton.tsx';
import { MessageInfoDropdown } from './MessageInfoDropdown.tsx';
import { isHiddenCommandOutput, SlashCommandOutput } from './SlashCommandOutput.tsx';
import { SyntheticMessageBlock } from './SyntheticMessageBlock.tsx';
import type { JSX } from 'preact';
import { Fragment } from 'preact';
import type { ReferenceMetadata } from '@hyperneo/shared';

function renderMessageText(
  text: string,
  metadata: ReferenceMetadata,
  sessionId?: string
): JSX.Element {
  if (!text.includes('@ref{')) {
    return <>{text}</>;
  }

  const segments = parseTextWithReferences(text, metadata);

  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.kind === 'text') {
          return <Fragment key={idx}>{seg.content}</Fragment>;
        }
        if (seg.kind === 'mention') {
          return (
            <MentionToken
              key={idx}
              refType={seg.refType}
              id={seg.id}
              displayText={seg.displayText}
              status={seg.status}
              sessionId={sessionId}
            />
          );
        }
        return (
          <span key={idx} class="text-yellow-500/70 italic" title="Unknown reference type">
            {seg.content}
          </span>
        );
      })}
    </>
  );
}

type UserMessage = Extract<SDKMessage, { type: 'user' }> & {
  deliveryStatus?: MessageDeliveryStatus;
  deliveryRetry?: MessageDeliveryRetryInfo;
  id?: string;
};
type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

const DELIVERY_BADGE_COPY: Record<
  Exclude<MessageDeliveryStatus, 'delivered'>,
  { label: string; tooltip: string }
> = {
  queued: { label: 'queued', tooltip: 'Waiting to be delivered' },
  processing: { label: 'sending', tooltip: 'Sending to the active turn' },
  retrying: { label: 'retrying', tooltip: 'Delivery stalled — retrying' },
  failed: {
    label: 'not delivered',
    tooltip: 'Message was not delivered — the server crashed before Claude responded',
  },
};

function UserMessageDeliveryBadge({
  status,
}: {
  status: Exclude<MessageDeliveryStatus, 'delivered'>;
}) {
  const copy = DELIVERY_BADGE_COPY[status];
  if (!copy) return null;
  return (
    <Tooltip content={copy.tooltip} position="left">
      <DeliveryStateBadge state={status} label={copy.label} test-id="user-delivery-state" />
    </Tooltip>
  );
}

function formatRetryCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  return `${seconds}s`;
}

function UserMessageRetryControl({
  sessionId,
  messageDbId,
  deliveryStatus,
  deliveryRetry,
}: {
  sessionId?: string;
  messageDbId?: string;
  deliveryStatus?: MessageDeliveryStatus;
  deliveryRetry?: MessageDeliveryRetryInfo;
}) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, (deliveryRetry?.runAt ?? 0) - Date.now())
  );
  const [retrying, setRetrying] = useState(false);

  useVisibleTick(1000, deliveryStatus === 'retrying' && !!deliveryRetry?.runAt, () =>
    setRemaining(Math.max(0, (deliveryRetry?.runAt ?? 0) - Date.now()))
  );

  const handleRetry = useCallback(async () => {
    if (!sessionId || !messageDbId) return;
    setRetrying(true);
    try {
      const result = await retryMessageDelivery(sessionId, messageDbId);
      if (!result.retried) {
        toast.error('Message could not be retried — it may no longer be in a failed state.');
      }
    } catch {
      toast.error('Failed to retry message. Please try again.');
    } finally {
      setRetrying(false);
    }
  }, [sessionId, messageDbId]);

  if (deliveryStatus === 'retrying') {
    const attempt = deliveryRetry
      ? `retry ${deliveryRetry.count}${deliveryRetry.maxRetries ? `/${deliveryRetry.maxRetries}` : ''}`
      : '';
    return (
      <span
        class="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-orange-200"
        role="status"
        aria-live="polite"
        data-testid="user-delivery-retry-countdown"
      >
        retrying in {formatRetryCountdown(remaining)}
        {attempt && <span class="text-orange-300/60 normal-case font-normal">· {attempt}</span>}
      </span>
    );
  }

  if (deliveryStatus === 'failed' && sessionId && messageDbId) {
    return (
      <button
        type="button"
        onClick={handleRetry}
        disabled={retrying}
        class="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border border-red-500/45 bg-red-500/10 text-red-200 hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-dark-950"
        data-testid="user-delivery-retry-button"
      >
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    );
  }

  return null;
}

function isDeliveryTerminal(status: MessageDeliveryStatus | undefined): boolean {
  if (!status) return true;
  return status === 'delivered' || status === 'failed';
}

interface Props {
  message: UserMessage;
  onEdit?: () => void;
  onDelete?: () => void;
  sessionInfo?: SystemInitMessage;
  isReplay?: boolean;
  sessionId?: string;
  onRewind?: (uuid: string) => void;
  rewindingMessageUuid?: string | null;
  showToolResultMessages?: boolean;
}

export function SDKUserMessage({
  message,
  onEdit: _onEdit,
  onDelete: _onDelete,
  sessionInfo,
  isReplay,
  sessionId,
  onRewind,
  rewindingMessageUuid,
  showToolResultMessages = false,
}: Props) {
  const { message: apiMessage } = message;
  const [copied, setCopied] = useState(false);

  const isToolResultMessage = (): boolean => {
    if (Array.isArray(apiMessage.content)) {
      return apiMessage.content.some(
        (block: unknown) => (block as Record<string, unknown>).type === 'tool_result'
      );
    }
    return false;
  };

  if (isToolResultMessage() && !showToolResultMessages) {
    return null;
  }

  if (isReplay) {
    const content = typeof apiMessage.content === 'string' ? apiMessage.content : '';
    if (isHiddenCommandOutput(content)) {
      return null;
    }
  }

  const getTextContent = (): string => {
    if (Array.isArray(apiMessage.content)) {
      return apiMessage.content
        .map((block: unknown) => {
          const b = block as Record<string, unknown>;
          if (b.type === 'text') {
            return b.text as string;
          }
          if (b.type === 'tool_result') {
            const rawContent = b.content;
            if (typeof rawContent === 'string') return rawContent;
            if (Array.isArray(rawContent)) {
              return rawContent
                .map((c: unknown) => {
                  const obj = c as Record<string, unknown>;
                  if (typeof obj.text === 'string') return obj.text;
                  return '';
                })
                .filter(Boolean)
                .join('\n');
            }
            if (rawContent && typeof rawContent === 'object') {
              try {
                return JSON.stringify(rawContent, null, 2);
              } catch {
                return String(rawContent);
              }
            }
            return '';
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (typeof apiMessage.content === 'string') {
      return apiMessage.content;
    }
    return '';
  };

  const getImageBlocks = (): Array<Record<string, unknown>> => {
    if (!Array.isArray(apiMessage.content)) return [];

    return apiMessage.content.filter((block: unknown) => {
      const b = block as Record<string, unknown>;
      return b.type === 'image';
    }) as unknown as Array<Record<string, unknown>>;
  };

  const textContent = getTextContent();
  const imageBlocks = getImageBlocks();

  const referenceMetadata: ReferenceMetadata =
    (message as typeof message & { referenceMetadata?: ReferenceMetadata }).referenceMetadata ?? {};

  const getSyntheticContentBlocks = (): Array<Record<string, unknown>> | string | null => {
    if (!message.isSynthetic) return null;

    if (Array.isArray(apiMessage.content)) {
      return apiMessage.content.map((block: unknown) => {
        if (typeof block === 'object' && block !== null) {
          return block as unknown as Record<string, unknown>;
        }
        return { type: 'unknown', content: block };
      });
    }

    if (typeof apiMessage.content === 'string') {
      return apiMessage.content;
    }

    return null;
  };

  const syntheticContentBlocks = getSyntheticContentBlocks();

  const hasCommandOutput = (): boolean => {
    if (!isReplay) return false;
    return /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/.test(textContent);
  };

  const containsErrorOutput = (): boolean => {
    return hasErrorOutput(textContent);
  };

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    const success = await copyToClipboard(textContent);
    if (success) {
      setCopied(true);
    } else {
      toast.error('Failed to copy message');
    }
  };

  const getTimestamp = (): string => {
    const messageWithTimestamp = message as SDKMessage & { timestamp?: number };
    const date = messageWithTimestamp.timestamp
      ? new Date(messageWithTimestamp.timestamp)
      : new Date();
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getFullTimestamp = (): string => {
    const messageWithTimestamp = message as SDKMessage & { timestamp?: number };
    const date = messageWithTimestamp.timestamp
      ? new Date(messageWithTimestamp.timestamp)
      : new Date();
    return date.toLocaleString();
  };

  if (isReplay && hasCommandOutput()) {
    return (
      <div class={cn(messageSpacing.assistant.container.combined)}>
        <SlashCommandOutput content={textContent} />
      </div>
    );
  }

  if (containsErrorOutput()) {
    return (
      <div class={cn(messageSpacing.assistant.container.combined)}>
        <ErrorOutput content={textContent} />
      </div>
    );
  }

  const messageWithTimestamp = message as SDKMessage & { timestamp?: number };

  const messageBubble = syntheticContentBlocks ? (
    <SyntheticMessageBlock
      content={syntheticContentBlocks}
      timestamp={messageWithTimestamp.timestamp}
      uuid={message.uuid}
      showActions={false}
    />
  ) : (
    <div
      class={cn(
        messageColors.user.background,
        borderRadius.message.bubble,
        messageSpacing.user.bubble.combined
      )}
    >
      <div class={cn(messageColors.user.text, 'whitespace-pre-wrap break-words')}>
        {renderMessageText(textContent, referenceMetadata, sessionId)}
      </div>

      {imageBlocks.length > 0 && (
        <div class="mt-3 space-y-2">
          {imageBlocks.map((img, idx) => {
            const source = img.source as Record<string, unknown>;
            const mediaType = source.media_type as string;
            const data = source.data as string;

            return (
              <div key={idx} class="rounded overflow-hidden border border-gray-600/50">
                <img
                  src={`data:${mediaType};base64,${data}`}
                  alt="Attached image"
                  class="max-w-full h-auto"
                />
              </div>
            );
          })}
        </div>
      )}

      {message.parent_tool_use_id && (
        <div class="mt-2 text-xs text-gray-500 dark:text-gray-400 italic">
          Sub-agent message (parent: {message.parent_tool_use_id.slice(0, 8)}...)
        </div>
      )}
    </div>
  );

  const messageActions = (
    <div
      class={cn(
        'flex items-center justify-end',
        messageSpacing.actions.gap,
        messageSpacing.actions.marginTop,
        messageSpacing.actions.padding
      )}
    >
      <Tooltip content={getFullTimestamp()} position="left">
        <span class="text-xs text-gray-500">{getTimestamp()}</span>
      </Tooltip>

      {message.isSynthetic && (
        <Tooltip content="System-generated message" position="left">
          <span class="text-xs px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded">
            synthetic
          </span>
        </Tooltip>
      )}

      {message.deliveryStatus && message.deliveryStatus !== 'delivered' && (
        <UserMessageDeliveryBadge status={message.deliveryStatus} />
      )}

      <UserMessageRetryControl
        sessionId={sessionId}
        messageDbId={typeof message.id === 'string' ? message.id : undefined}
        deliveryStatus={message.deliveryStatus}
        deliveryRetry={message.deliveryRetry}
      />

      {!isReplay &&
        onRewind &&
        sessionId &&
        message.uuid &&
        isDeliveryTerminal(message.deliveryStatus) &&
        (rewindingMessageUuid === message.uuid ? (
          <Spinner size="sm" color="border-amber-500" />
        ) : (
          <Tooltip content="Rewind to this message" position="left">
            <IconButton size="md" onClick={() => onRewind(message.uuid!)} title="Rewind to here">
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                />
              </svg>
            </IconButton>
          </Tooltip>
        ))}

      {sessionInfo && (
        <Dropdown
          trigger={<MessageInfoButton />}
          items={[]}
          customContent={<MessageInfoDropdown sessionInfo={sessionInfo} />}
        />
      )}

      <IconButton
        size="md"
        onClick={handleCopy}
        title={copied ? 'Copied!' : 'Copy message'}
        class={copied ? 'text-green-400' : ''}
      >
        {copied ? (
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
        )}
      </IconButton>
    </div>
  );

  const messageContent = (
    <div
      class={cn(messageSpacing.user.container.combined, 'flex justify-end')}
      data-testid={syntheticContentBlocks ? 'synthetic-message' : 'user-message'}
      data-message-role={syntheticContentBlocks ? 'synthetic' : 'user'}
      data-message-uuid={message.uuid ?? ''}
      data-message-timestamp={messageWithTimestamp.timestamp || 0}
    >
      <div class="max-w-[85%] md:max-w-[70%] w-auto">
        {messageBubble}
        {messageActions}
      </div>
    </div>
  );

  return messageContent;
}
