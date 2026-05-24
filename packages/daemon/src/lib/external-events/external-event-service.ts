/**
 * ExternalEventService — source-agnostic external event publishing.
 *
 * Implements `ExternalEventPublisher`:
 *   - Validates source/topic contracts via `ExternalEventStore`.
 *   - Stores/dedupes via `ExternalEventStore`.
 *   - Publishes `externalEvent.published` on `InternalEventBus` with a space-scoped
 *     channel/payload.
 *
 * No task resolution happens in this service — the event pipeline is intentionally
 * agnostic to task-system concerns. Task matching is the responsibility of
 * subscribers (e.g. the workflow runtime, agent tools).
 *
 * No session injection happens in this service — delivery is a workflow-runtime
 * and agent concern, not an event-pipeline concern.
 */

import type { InternalEventBus } from '../internal-event-bus';
import type { ExternalEventStore } from './external-event-store';
import type { ExternalEvent } from './types';

export type PublishOutcome = 'published' | 'duplicate_terminal' | 'retryable_duplicate';

export interface PublishResult {
  outcome: PublishOutcome;
  /** The canonical event id (original id for duplicates, caller id otherwise). */
  eventId: string;
}

/**
 * Payload for `externalEvent.published` — emitted after a successful (non-duplicate)
 * store so subscribers can react to new external events.
 *
 * Includes the full normalized event so subscribers can perform source-specific
 * matching/routing without an extra store lookup.
 */
export interface ExternalEventPublishedPayload {
  namespaceId: string;
  spaceId: string;
  eventId: string;
  source: string;
  topic: string;
  dedupeKey: string;
  summary: string;
  externalUrl?: string;
  payload: Record<string, unknown>;
  occurredAt: number;
  ingestedAt: number;
  [key: string]: unknown;
}

export interface ExternalEventPublisher {
  publish(event: ExternalEvent): Promise<PublishResult>;
}

export class ExternalEventService implements ExternalEventPublisher {
  constructor(
    private readonly store: ExternalEventStore,
    private readonly bus: InternalEventBus<{
      'externalEvent.published': ExternalEventPublishedPayload;
    }>
  ) {}

  async publish(event: ExternalEvent): Promise<PublishResult> {
    const storeResult = this.store.store(event);

    if (storeResult.duplicate) {
      if (storeResult.terminal) {
        return {
          outcome: 'duplicate_terminal',
          eventId: storeResult.event.id,
        };
      }
      // Retryable duplicate — re-emit the canonical bus payload so failed
      // subscribers can recover.
      return await this._handleRetryableDuplicate(storeResult.event);
    }

    // First observation — publish the event.
    return await this._handleFirstObservation(event);
  }

  /**
   * Handle a first-observation (non-duplicate) event.
   *
   * Always publishes `externalEvent.published` so subscribers see every newly
   * stored event.
   *
   * Uses the canonical event read back from storage so the payload is
   * JSON-normalized (same as retryable duplicates), preventing subscriber
   * idempotency issues caused by non-JSON values (e.g. `undefined`) that are
   * dropped during `JSON.stringify`/`JSON.parse` round-tripping.
   */
  private async _handleFirstObservation(event: ExternalEvent): Promise<PublishResult> {
    const canonical = this.store.getById(event.id);
    if (!canonical) {
      // Theoretically impossible — we just inserted this row. Fall back to
      // the caller-provided event so the bus still fires.
      await this._publishBusEvent(event);
      return { outcome: 'published', eventId: event.id };
    }
    await this._publishBusEvent(canonical.event);
    return { outcome: 'published', eventId: event.id };
  }

  /**
   * Handle a retryable duplicate.
   *
   * Re-emits the canonical bus payload so failed subscribers recover.
   * The event stays in `published` state — terminalization is the workflow
   * runtime's responsibility after delivery completes or fails.
   */
  private async _handleRetryableDuplicate(canonicalEvent: ExternalEvent): Promise<PublishResult> {
    await this._publishBusEvent(canonicalEvent);
    return {
      outcome: 'retryable_duplicate',
      eventId: canonicalEvent.id,
    };
  }

  /**
   * Helper to publish `externalEvent.published`.
   */
  private async _publishBusEvent(event: ExternalEvent): Promise<void> {
    await this.bus.publish('externalEvent.published', {
      namespaceId: event.spaceId,
      spaceId: event.spaceId,
      eventId: event.id,
      source: event.source,
      topic: event.topic,
      dedupeKey: event.dedupeKey,
      summary: event.summary,
      externalUrl: event.externalUrl,
      payload: event.payload,
      occurredAt: event.occurredAt,
      ingestedAt: event.ingestedAt,
    });
  }
}
