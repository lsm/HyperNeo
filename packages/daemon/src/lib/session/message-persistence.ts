import type {
  ImageContent,
  MessageContent,
  MessageDeliveryMode,
  MessageHub,
  MessageImage,
  MessageOrigin,
  ReferenceMetadata,
  Session,
} from '@hyperneo/shared';
import { composeDraftWhole } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { Database } from '../../storage/database.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import {
  buildReferenceContext,
  prependContextToMessage,
} from '../agent/reference-context-builder.ts';
import {
  isMessageDeliveryV2Enabled,
  withSessionResetCoordination,
} from '../agent/message-delivery.ts';
import { persistAndEnqueueDelivery } from '../agent/message-delivery-outbox.ts';
import { expandBuiltInCommand } from '../built-in-commands.ts';
import { Logger } from '../logger.ts';
import type { SessionCache } from './session-cache.ts';
import {
  ReferenceResolver,
  type PreprocessedMessage,
  type ResolutionContext,
} from './reference-resolver.ts';

type MessageImageInput = MessageImage | ImageContent;

export const MAX_IMAGE_BASE64_SIZE = 5 * 1024 * 1024;

export function validateImageSizes(images: ReadonlyArray<MessageImageInput>): void {
  for (const image of images) {
    const base64SizeBytes = getImageData(image).length;
    if (base64SizeBytes > MAX_IMAGE_BASE64_SIZE) {
      const sizeMB = (base64SizeBytes / (1024 * 1024)).toFixed(2);
      const maxMB = (MAX_IMAGE_BASE64_SIZE / (1024 * 1024)).toFixed(2);
      throw new Error(
        `Image base64 size (${sizeMB} MB) exceeds API limit (${maxMB} MB). Please resize the image before uploading.`
      );
    }
  }
}

export interface MessagePersistenceData {
  sessionId: string;
  messageId: string;
  content: string;
  images?: MessageImageInput[];
  deliveryMode?: MessageDeliveryMode;
  origin?: MessageOrigin;
}

export class MessagePersistence {
  private logger: Logger;

  constructor(
    private sessionCache: SessionCache,
    private db: Database,
    private messageHub: MessageHub,
    private internalEventBus: InternalEventBus<DaemonInternalEventMap>,
    private referenceResolver?: ReferenceResolver
  ) {
    this.logger = new Logger('MessagePersistence');
  }

  private async preprocessReferences(text: string, session: Session): Promise<PreprocessedMessage> {
    try {
      const mentions = ReferenceResolver.extractReferences(text);
      if (mentions.length === 0) {
        return { text, referenceMetadata: {}, resolvedReferences: {} };
      }

      const context: ResolutionContext = {
        workspacePath: session.worktree?.worktreePath ?? session.workspacePath ?? null,
        roomId: session.context?.roomId ?? null,
      };

      const resolved = await this.referenceResolver!.resolveAllReferences(mentions, context);

      const referenceMetadata: ReferenceMetadata = {};

      for (const [token, ref] of Object.entries(resolved)) {
        referenceMetadata[token] = {
          type: ref.type,
          id: ref.id,
          displayText: extractDisplayText(ref.type, ref.id, ref.data),
        };
      }

      const seenTokens = new Set<string>();
      for (const mention of mentions) {
        const token = `@ref{${mention.type}:${mention.id}}`;
        if (!seenTokens.has(token) && !(token in referenceMetadata)) {
          seenTokens.add(token);
          referenceMetadata[token] = {
            type: mention.type,
            id: mention.id,
            displayText: mention.id,
            status: 'unresolved',
          };
        }
      }

      return { text, referenceMetadata, resolvedReferences: resolved };
    } catch (err) {
      this.logger.warn('[MessagePersistence] Reference preprocessing failed, skipping:', err);
      return { text, referenceMetadata: {}, resolvedReferences: {} };
    }
  }

  async persist(data: MessagePersistenceData): Promise<void> {
    const { sessionId, messageId, content, images, deliveryMode = 'immediate', origin } = data;

    const persistedSession = this.db.getSession?.(sessionId);
    if (persistedSession?.status === 'archived') {
      throw new Error(
        `[MessagePersistence] Session ${sessionId} is archived; cannot accept new messages.`
      );
    }

    const preSendDraft = persistedSession?.metadata?.inputDraft ?? '';
    const preSendPending = persistedSession?.metadata?.inputDraftVoicePending ?? '';
    const preSendComposed = preSendPending.trim()
      ? composeDraftWhole(preSendDraft, preSendPending)
      : null;
    const compositionAtSend =
      preSendComposed !== null && content.trim().includes(preSendComposed.trim());

    const agentSession = await this.sessionCache.getAsync(sessionId);
    if (!agentSession) {
      const error = `[MessagePersistence] Session ${sessionId} not found for message persistence`;
      this.logger.error(error);
      throw new Error(error);
    }

    const session = agentSession.getSessionData();

    try {
      if (images && images.length > 0) {
        validateImageSizes(images);
      }

      const expandedContent = expandBuiltInCommand(content);
      const finalContent = expandedContent || content;

      const preprocessed = this.referenceResolver
        ? await this.preprocessReferences(finalContent, session)
        : {
            text: finalContent,
            referenceMetadata: {} as ReferenceMetadata,
            resolvedReferences: {},
          };

      const refContext = buildReferenceContext(preprocessed.resolvedReferences);
      const agentContent = prependContextToMessage(finalContent, refContext);

      const messageContent = buildMessageContent(agentContent, images);

      const sdkUserMessage: SDKUserMessage & { referenceMetadata?: ReferenceMetadata } = {
        type: 'user' as const,
        uuid: messageId as UUID,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user' as const,
          content:
            typeof messageContent === 'string'
              ? [{ type: 'text' as const, text: messageContent }]
              : messageContent,
        },
        ...(Object.keys(preprocessed.referenceMetadata).length > 0 && {
          referenceMetadata: preprocessed.referenceMetadata,
        }),
      };

      const processingState = agentSession.getProcessingState();
      const isAgentBusy =
        processingState.status === 'processing' || processingState.status === 'queued';
      const isManualMode = session.config.queryMode === 'manual';

      const effectiveDeliveryMode: MessageDeliveryMode =
        deliveryMode === 'defer' && isAgentBusy ? 'defer' : 'immediate';
      const shouldDispatchToQuery = !isManualMode && effectiveDeliveryMode === 'immediate';
      const sendStatus: 'deferred' | 'enqueued' | 'consumed' = isManualMode
        ? 'deferred'
        : effectiveDeliveryMode === 'defer'
          ? 'deferred'
          : 'enqueued';

      const useV2Delivery = isMessageDeliveryV2Enabled();
      const jobQueueRepo = this.db.getJobQueueRepo?.();
      const useOutbox = shouldDispatchToQuery && useV2Delivery && !!jobQueueRepo;
      let dbMessageId: string;
      let outboxRole: 'turn' | 'steer' | undefined;
      if (useOutbox) {
        if (this.db.getSession?.(sessionId)?.status === 'archived') {
          dbMessageId = this.db.saveUserMessage(sessionId, sdkUserMessage, 'failed', origin);
          await this.internalEventBus
            .publish('messages.statusChanged', {
              sessionId,
              messageIds: [dbMessageId],
              status: 'failed',
            })
            .catch(() => {});
          throw new Error(`Session ${sessionId} is archived`);
        }
        const outbox = await withSessionResetCoordination(sessionId, async () =>
          persistAndEnqueueDelivery({
            db: this.db.getDatabase(),
            sdkMessageRepo: this.db.getSDKMessageRepo(),
            jobQueue: jobQueueRepo,
            sessionId,
            message: sdkUserMessage,
            sendStatus,
            origin,
            delivery: { origin: 'chat' },
          })
        );
        dbMessageId = outbox.dbMessageId;
        outboxRole = outbox.role;
        if (outboxRole === 'turn') {
          await agentSession.stateManager.setQueuedIfIdle(messageId).catch(() => {});
        }
      } else {
        dbMessageId = this.db.saveUserMessage(sessionId, sdkUserMessage, sendStatus, origin);
      }

      if (this.db.getSession?.(sessionId)?.status === 'archived') {
        const flipped = this.db
          .getSDKMessageRepo?.()
          ?.markDeliveryFailedByUuid?.(sessionId, messageId);
        if (flipped) {
          await this.internalEventBus
            .publish('messages.statusChanged', {
              sessionId,
              messageIds: [flipped],
              status: 'failed',
            })
            .catch(() => {});
        }
        throw new Error(`Session ${sessionId} is archived`);
      }

      if (isManualMode) {
        try {
          this.messageHub.event(
            'state.sdkMessages.delta',
            { added: [sdkUserMessage], timestamp: Date.now() },
            { channel: `session:${sessionId}` }
          );
        } catch (_err) {
          /* v8 ignore next 2 */
          this.logger.error('[MessagePersistence] Error publishing message to UI:', _err);
        }
      }

      await this.internalEventBus
        .publish('messages.statusChanged', {
          sessionId,
          messageIds: [dbMessageId],
          status: sendStatus,
        })
        .catch((err) =>
          this.logger.warn('[MessagePersistence] statusChanged publish failed:', err)
        );

      if (shouldDispatchToQuery && !useV2Delivery) {
        await withSessionResetCoordination(sessionId, async () => {
          await agentSession.startQueryAndEnqueue(messageId, messageContent);
        });
      }
      if (shouldDispatchToQuery) {
        await this.internalEventBus
          .publish('message.persisted', {
            sessionId,
            messageId,
            messageContent,
            userMessageText: content,
            needsWorkspaceInit:
              !session.metadata.titleGenerated && session.metadata.titleSetBy !== 'user',
            hasDraftToClear: preSendDraft.trim() === content.trim() || compositionAtSend,
            ...(compositionAtSend ? { voicePendingSent: preSendPending } : {}),
            sendStatus,
            deliveryMode: effectiveDeliveryMode,
            skipQueryStart: !useV2Delivery || useOutbox,
          })
          .catch((err) =>
            this.logger.warn('[MessagePersistence] message.persisted publish failed:', err)
          );
      }
    } catch (error) {
      this.logger.error('[MessagePersistence] Error persisting message:', error);
      throw error;
    }
  }
}

function extractDisplayText(type: string, id: string, data: unknown): string {
  if (data !== null && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if ((type === 'task' || type === 'goal') && typeof d['title'] === 'string') {
      return d['title'];
    }
    if ((type === 'file' || type === 'folder') && typeof d['path'] === 'string') {
      return d['path'];
    }
  }
  return id;
}

function buildMessageContent(
  content: string,
  images?: MessageImageInput[]
): string | MessageContent[] {
  if (!images || images.length === 0) {
    return content;
  }

  return [...images.map(toImageContent), { type: 'text' as const, text: content }];
}

function getImageData(image: MessageImageInput): string {
  return 'source' in image ? image.source.data : image.data;
}

function toImageContent(image: MessageImageInput): ImageContent {
  if ('source' in image) {
    return image;
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.media_type,
      data: image.data,
    },
  };
}
