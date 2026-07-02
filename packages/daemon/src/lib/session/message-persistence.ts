/**
 * Message Persistence Module
 *
 * Handles user message persistence to database and UI broadcasting:
 * - Expand built-in commands
 * - Build message content (text + images)
 * - Create SDK user message format
 * - Save to database
 * - Publish to UI via state channels
 * - Emit events for downstream processing
 */

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
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { Database } from '../../storage/database';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { buildReferenceContext, prependContextToMessage } from '../agent/reference-context-builder';
import { expandBuiltInCommand } from '../built-in-commands';
import { Logger } from '../logger';
import type { SessionCache } from './session-cache';
import {
  ReferenceResolver,
  type PreprocessedMessage,
  type ResolutionContext,
} from './reference-resolver';

type MessageImageInput = MessageImage | ImageContent;

/**
 * Anthropic API limit for base64-encoded image data per attachment.
 * Exceeding this returns a late, opaque API error, so we validate
 * server-side before persisting/queueing the SDK user message.
 */
export const MAX_IMAGE_BASE64_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Validate base64 image sizes against the Anthropic API limit and throw a
 * user-facing error before any persistence happens. Used by the live-session
 * persistence path and by space task message injection (where the workflow
 * agent enqueues the message into a sub-session) so both paths return the
 * same early "resize image" error instead of a downstream API failure.
 */
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

  /**
   * Extract and resolve @ references from a message text.
   *
   * Returns a PreprocessedMessage with the original text unchanged and a
   * populated referenceMetadata map. If no references are found, or if
   * resolution fails entirely, returns empty metadata so the message
   * still persists normally.
   */
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

      // Include resolved references with entity titles as displayText
      for (const [token, ref] of Object.entries(resolved)) {
        referenceMetadata[token] = {
          type: ref.type,
          id: ref.id,
          displayText: extractDisplayText(ref.type, ref.id, ref.data),
        };
      }

      // Include unresolved references with status: 'unresolved' so the UI can surface failures
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

  /**
   * Handle message persistence
   *
   * ARCHITECTURE: InternalEventBus<DaemonInternalEventMap>-centric - SessionManager owns message persistence logic
   *
   * Responsibilities:
   * 1. Validate image sizes
   * 2. Expand built-in commands
   * 3. Build message content (text + images)
   * 4. Create SDK user message
   * 5. Save to database
   * 6. Publish to UI via state channel
   * 7. Emit 'message.persisted' event for downstream processing
   */
  async persist(data: MessagePersistenceData): Promise<void> {
    const { sessionId, messageId, content, images, deliveryMode = 'immediate', origin } = data;

    const agentSession = await this.sessionCache.getAsync(sessionId);
    if (!agentSession) {
      const error = `[MessagePersistence] Session ${sessionId} not found for message persistence`;
      this.logger.error(error);
      // FIX: Throw instead of returning early so error is propagated
      // This prevents messages from being silently lost when session fails to load
      throw new Error(error);
    }

    const session = agentSession.getSessionData();

    try {
      // 1. Validate image sizes (API limit is 5MB for base64-encoded data)
      if (images && images.length > 0) {
        validateImageSizes(images);
      }

      // 2. Expand built-in commands (e.g., /merge-session → full prompt)
      const expandedContent = expandBuiltInCommand(content);
      const finalContent = expandedContent || content;

      // 2b. Preprocess @ references (extract + resolve) if resolver is available
      const preprocessed = this.referenceResolver
        ? await this.preprocessReferences(finalContent, session)
        : {
            text: finalContent,
            referenceMetadata: {} as ReferenceMetadata,
            resolvedReferences: {},
          };

      // 2c. Build reference context block and prepend to agent message
      const refContext = buildReferenceContext(preprocessed.resolvedReferences);
      const agentContent = prependContextToMessage(finalContent, refContext);

      // 3. Build message content (text + images)
      const messageContent = buildMessageContent(agentContent, images);

      // 4. Create SDK user message
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

      // 5. Save to database with delivery-aware status
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

      const dbMessageId = this.db.saveUserMessage(sessionId, sdkUserMessage, sendStatus, origin);

      // 6. Publish manual messages immediately. Immediate-mode messages are
      // rendered when the SDK input generator consumes them and flips their
      // status to `consumed`, which prevents a "visible but undelivered" turn.
      //
      // Note: `origin` is intentionally NOT included in the live-push event payload.
      // `origin` is a DB-level annotation only — the SDK message blob never carries it.
      // The frontend reads `origin` from the DB (via getSDKMessages) after page load or
      // of an injected message; they appear after the client re-fetches the message list.
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

      // Broadcast status update for queue-aware UI
      await this.internalEventBus.publish('messages.statusChanged', {
        sessionId,
        messageIds: [dbMessageId],
        status: sendStatus,
      });

      // 7. For immediate delivery, start the query and enqueue before acknowledging
      // the caller. The message is still rendered only after SDKMessageHandler
      // flips it to `consumed` at the exact delivery point.
      if (shouldDispatchToQuery) {
        await agentSession.startQueryAndEnqueue(messageId, messageContent);
      }

      // 8. Emit 'message.persisted' for non-critical post-processing.
      // Query start is handled above synchronously; the event remains for title
      // generation, draft clearing, and legacy subscribers.
      if (shouldDispatchToQuery) {
        await this.internalEventBus.publish('message.persisted', {
          sessionId,
          messageId,
          messageContent,
          userMessageText: content, // Original content (before expansion)
          // Auto-title init is needed only when no title has been settled yet —
          // either auto-generated or manually set by the user (titleSetBy).
          needsWorkspaceInit:
            !session.metadata.titleGenerated && session.metadata.titleSetBy !== 'user',
          hasDraftToClear: session.metadata?.inputDraft === content.trim(),
          sendStatus,
          deliveryMode: effectiveDeliveryMode,
          skipQueryStart: true,
        });
      }
    } catch (error) {
      this.logger.error('[MessagePersistence] Error persisting message:', error);
      throw error;
    }
  }
}

/**
 * Extract a human-readable display text from a resolved reference's entity data.
 *
 * For tasks and goals, uses the entity title. For files and folders, uses the path.
 * Falls back to the raw ID if the data shape is unexpected.
 */
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

/**
 * Build message content from text and optional images
 * Static utility function for building SDK message content
 */
function buildMessageContent(
  content: string,
  images?: MessageImageInput[]
): string | MessageContent[] {
  if (!images || images.length === 0) {
    return content;
  }

  // Multi-modal message: array of content blocks
  // Images first, then text (SDK format)
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
