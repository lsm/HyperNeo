import { validateLiteralTopic, validateSource } from './topic-validator.ts';
import type { ExternalEvent } from './types.ts';

export class ExternalEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalEventValidationError';
  }
}

export function validateExternalEvent(event: ExternalEvent): string | null {
  if (!event.id || typeof event.id !== 'string') return 'ExternalEvent.id is required';
  if (!event.spaceId || typeof event.spaceId !== 'string') {
    return 'ExternalEvent.spaceId is required';
  }
  if (
    !event.dedupeKey ||
    typeof event.dedupeKey !== 'string' ||
    event.dedupeKey.trim().length === 0
  ) {
    return 'ExternalEvent.dedupeKey is required and must not be whitespace-only';
  }
  if (event.dedupeKey !== event.dedupeKey.trim()) {
    return 'ExternalEvent.dedupeKey must not have leading or trailing whitespace';
  }

  const sourceCheck = validateSource(event.source);
  if (!sourceCheck.valid) return `ExternalEvent.source invalid: ${sourceCheck.reason}`;

  const topicCheck = validateLiteralTopic(event.topic);
  if (!topicCheck.valid) return `ExternalEvent.topic invalid: ${topicCheck.reason}`;

  const firstSegment = event.topic.split('/')[0];
  if (firstSegment !== event.source) {
    return `ExternalEvent.topic first segment "${firstSegment}" must equal source "${event.source}"`;
  }

  if (typeof event.occurredAt !== 'number' || !Number.isFinite(event.occurredAt)) {
    return 'ExternalEvent.occurredAt must be a finite number';
  }
  if (typeof event.ingestedAt !== 'number' || !Number.isFinite(event.ingestedAt)) {
    return 'ExternalEvent.ingestedAt must be a finite number';
  }
  if (typeof event.summary !== 'string') return 'ExternalEvent.summary must be a string';
  if (typeof event.payload !== 'object' || event.payload === null) {
    return 'ExternalEvent.payload must be an object';
  }
  return null;
}
