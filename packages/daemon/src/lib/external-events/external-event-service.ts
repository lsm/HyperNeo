import type { InternalEventBus } from '../internal-event-bus.ts';
import type { ExternalEventStore } from './external-event-store.ts';
import type { ExternalEvent } from './types.ts';

export type PublishOutcome = 'published' | 'duplicate_terminal' | 'retryable_duplicate';

export interface PublishResult {
  outcome: PublishOutcome;
  eventId: string;
}

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
      return await this._handleRetryableDuplicate(storeResult.event);
    }

    return await this._handleFirstObservation(event);
  }

  private async _handleFirstObservation(event: ExternalEvent): Promise<PublishResult> {
    const canonical = this.store.getById(event.id);
    if (!canonical) {
      await this._publishBusEvent(event);
      return { outcome: 'published', eventId: event.id };
    }
    await this._publishBusEvent(canonical.event);
    return { outcome: 'published', eventId: event.id };
  }

  private async _handleRetryableDuplicate(canonicalEvent: ExternalEvent): Promise<PublishResult> {
    await this._publishBusEvent(canonicalEvent);
    return {
      outcome: 'retryable_duplicate',
      eventId: canonicalEvent.id,
    };
  }

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
