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
import { appendDraftText } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { UUID } from 'crypto';
import type { Database } from '../../storage/database';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { buildReferenceContext, prependContextToMessage } from '../agent/reference-context-builder';
import { isMessageDeliveryV2Enabled } from '../agent/message-delivery';
import { persistAndEnqueueDelivery } from '../agent/message-delivery-outbox';
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

    // Persisted session status is the admission barrier. Check it BEFORE cache
    // hydration: constructing an archived AgentSession schedules pending replay,
    // which could restart cancelled prompts even though this send later rejects.
    const persistedSession = this.db.getSession?.(sessionId);
    if (persistedSession?.status === 'archived') {
      throw new Error(
        `[MessagePersistence] Session ${sessionId} is archived; cannot accept new messages.`
      );
    }

    const agentSession = await this.sessionCache.getAsync(sessionId);
    if (!agentSession) {
      const error = `[MessagePersistence] Session ${sessionId} not found for message persistence`;
      this.logger.error(error);
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

      const useV2Delivery = isMessageDeliveryV2Enabled();
      // Transactional outbox (task #861 item 2): when dispatching under v2,
      // persist the user message AND enqueue its durable delivery job in ONE
      // transaction so a crash between save and enqueue cannot strand a
      // saved-but-not-enqueued prompt. The `message.persisted` subscriber's
      // deliverChatMessage then no-ops the enqueue (idempotent via
      // getActiveDeliveryRole) and only sets the queued marker / cancels a
      // rate-limit episode — the atomic save+enqueue here is what removes the
      // crash window. The durable repos are always wired on the real Database
      // facade; the `getJobQueueRepo` presence gate only falls back to the bare
      // save for partial unit-test mocks.
      const jobQueueRepo = this.db.getJobQueueRepo?.();
      const useOutbox = shouldDispatchToQuery && useV2Delivery && !!jobQueueRepo;
      let dbMessageId: string;
      let outboxRole: 'turn' | 'steer' | undefined;
      if (useOutbox) {
        if (this.db.getSession?.(sessionId)?.status === 'archived') {
          // Archived before we save: persist as a visible `failed` row and stop
          // — never enqueue a job that would drive a torn-down session.
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
        const outbox = persistAndEnqueueDelivery({
          db: this.db.getDatabase(),
          sdkMessageRepo: this.db.getSDKMessageRepo(),
          jobQueue: jobQueueRepo,
          sessionId,
          message: sdkUserMessage,
          sendStatus,
          origin,
          delivery: { origin: 'chat' },
        });
        dbMessageId = outbox.dbMessageId;
        outboxRole = outbox.role;
        // Establish queued ownership IMMEDIATELY after the atomic insert when it
        // won the turn role — BEFORE the awaited messages.statusChanged /
        // message.persisted publications. Otherwise the session reads idle until
        // deliverChatMessage runs (inside the awaited publish), so a concurrent
        // deliveryMode:'defer' send is mis-converted to immediate (a steer into
        // this turn). setQueuedIfIdle is idempotent; deliverChatMessage's later
        // call is a harmless no-op. (Codex review.)
        if (outboxRole === 'turn') {
          await agentSession.stateManager.setQueuedIfIdle(messageId).catch(() => {});
        }
      } else {
        dbMessageId = this.db.saveUserMessage(sessionId, sdkUserMessage, sendStatus, origin);
      }

      // Revalidate AFTER saving: archive can begin after the early admission
      // check while cache/reference work awaits. Its point-in-time cancellation
      // may then run before this enqueued row exists. Terminalize the late row
      // and stop before message.persisted can enqueue work against torn-down
      // resources. The failed row remains visible instead of hidden forever.
      if (this.db.getSession?.(sessionId)?.status === 'archived') {
        // Use the conditional UUID flip (only enqueued/deferred/submitted →
        // failed) — the outbox may have already committed a job + the processor
        // consumed the row during the preceding await; flipping a consumed row
        // to failed would be wrong (it WAS delivered). markDeliveryFailedByUuid
        // returns the dbId only when it actually flipped. (Codex review.)
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

      // Broadcast status update for queue-aware UI. Best-effort once the row is
      // saved: under v2 the outbox has already committed the durable job, so a
      // throwing subscriber must NOT reject the send (a client retry would mint a
      // fresh UUID and deliver twice). The non-v2 path also benefits — the save
      // already succeeded. (Codex review.)
      await this.internalEventBus
        .publish('messages.statusChanged', {
          sessionId,
          messageIds: [dbMessageId],
          status: sendStatus,
        })
        .catch((err) =>
          this.logger.warn('[MessagePersistence] statusChanged publish failed:', err)
        );

      // 7. For immediate delivery, start the query inline — UNLESS message-delivery
      // v2 is enabled, in which case the durable job_queue path owns dispatch:
      // the message.persisted subscriber (below) enqueues a message_delivery job
      // and the handler drives the turn. Skipping the inline start here is what
      // makes the v2 flag actually take effect (P0: otherwise skipQueryStart:true
      // made the subscriber return before the v2 check, so the flag did nothing).
      if (shouldDispatchToQuery && !useV2Delivery) {
        await agentSession.startQueryAndEnqueue(messageId, messageContent);
      }
      // 8. Emit 'message.persisted' for non-critical post-processing.
      // skipQueryStart reflects whether the inline start above already happened:
      // under v2 it is false so the subscriber proceeds to the v2 check and
      // routes through deliverChatMessage (the durable chokepoint). Best-effort
      // for the same reason as the statusChanged publish above.
      if (shouldDispatchToQuery) {
        await this.internalEventBus
          .publish('message.persisted', {
            sessionId,
            messageId,
            messageContent,
            userMessageText: content, // Original content (before expansion)
            // Auto-title init is needed only when no title has been settled yet —
            // either auto-generated or manually set by the user (titleSetBy).
            needsWorkspaceInit:
              !session.metadata.titleGenerated && session.metadata.titleSetBy !== 'user',
            // The draft is consumed by the send when it matches the sent text
            // directly OR through the voice composition: a sender whose
            // composer showed draft + staged transcript (session.get presents
            // the composition) sent both, so the subscriber consumes the
            // staging on that path. Computed from this pre-send snapshot as a
            // GATE only — the subscriber re-decides the exact match from a
            // fresh read.
            hasDraftToClear: (() => {
              const draft = session.metadata?.inputDraft ?? '';
              if (draft.trim() === content.trim()) return true;
              const pending = session.metadata?.inputDraftVoicePending;
              if (!pending || pending.trim() === '') return false;
              const composed = appendDraftText(draft, pending);
              const fitsWhole =
                composed === `${draft}${pending}` || composed === `${draft} ${pending}`;
              return fitsWhole && composed.trim() === content.trim();
            })(),
            sendStatus,
            deliveryMode: effectiveDeliveryMode,
            // The outbox already owns delivery (job enqueued + queued marker
            // set). Tell the subscriber to skip deliverChatMessage — if the
            // outbox job completed a fast turn before this publication, the
            // subscriber's getActiveDeliveryRole wouldn't find it (completed
            // jobs aren't active) and would insert a second turn job for the
            // consumed UUID, starting an input-less query. (Codex review.)
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
