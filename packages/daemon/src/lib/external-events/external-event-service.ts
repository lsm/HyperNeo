import type { InternalEventBus } from '../internal-event-bus.ts';
import { type ExternalEventStore, ExternalEventValidationError } from './external-event-store.ts';
import { ingestExternalEvent } from './ingest-external-event-pipeline.ts';
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

export function isExternalEventDeliveryV2Enabled(): boolean {
  const v = process.env.HYPERNEO_EXTERNAL_EVENT_DELIVERY_V2;
  return v !== '0' && v !== 'false';
}

export class ExternalEventService implements ExternalEventPublisher {
  constructor(
    private readonly store: ExternalEventStore,
    private readonly bus: InternalEventBus<{
      'externalEvent.published': ExternalEventPublishedPayload;
    }>
  ) {}

  async publish(event: ExternalEvent): Promise<PublishResult> {
    const outcome = ingestExternalEvent(
      { store: (candidate) => this.store.store(candidate) },
      event
    );

    if (outcome.action === 'invalid') {
      throw new ExternalEventValidationError(outcome.reason);
    }
    if (outcome.action === 'failed') {
      throw outcome.error;
    }
    if (outcome.action === 'duplicate') {
      if (outcome.terminal) {
        return {
          outcome: 'duplicate_terminal',
          eventId: outcome.eventId,
        };
      }
      const canonical = this.store.getById(outcome.eventId);
      if (!canonical) {
        throw new Error(
          `ExternalEventService.publish: duplicate reported but canonical row missing (${outcome.eventId})`
        );
      }
      return await this._handleRetryableDuplicate(canonical.event);
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
