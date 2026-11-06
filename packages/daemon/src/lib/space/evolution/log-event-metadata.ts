import type { StructuredLogEvent } from '@hyperneo/shared';

const MAX_SAMPLES = 5;

export function buildMetadata(
  event: StructuredLogEvent,
  fingerprint: string,
  state: { count: number; firstSeenAt: number; previousSamples: unknown[] }
): Record<string, unknown> {
  return redactLogValue({
    autoCaptured: true,
    logCaptureVersion: 1,
    logFingerprint: fingerprint,
    level: event.level,
    module: event.module ?? null,
    source: event.source,
    message: event.message,
    stack: event.stack ?? null,
    context: event.context,
    process: event.process,
    timestamp: event.timestamp,
    count: state.count,
    firstSeenAt: state.firstSeenAt,
    lastSeenAt: event.timestamp,
    lastWriteEventId: event.id,
    metadata: event.metadata,
    samples: [...state.previousSamples, sampleEvent(event)].slice(-MAX_SAMPLES),
  }) as Record<string, unknown>;
}

function sampleEvent(event: StructuredLogEvent): Record<string, unknown> {
  return {
    id: event.id,
    timestamp: event.timestamp,
    message: event.message,
    stackFirstLine: event.stack?.split('\n')[0] ?? null,
  };
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|api[-_]?key|authorization|cookie/i.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactLogValue(nested);
    }
  }
  return result;
}

export function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, '$1=[REDACTED]');
}
