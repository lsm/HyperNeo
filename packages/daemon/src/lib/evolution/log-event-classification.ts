import type { EvidenceKind, StructuredLogEvent } from '@hyperneo/shared';
import type { LogEvidenceSubscription } from './log-evidence-types.ts';
import { redactString } from './log-event-metadata.ts';

export function matchesSubscription(
  subscription: LogEvidenceSubscription,
  event: StructuredLogEvent
): boolean {
  if (!subscription.levels.includes(event.level)) return false;
  if (subscription.modules?.length && !subscription.modules.includes(event.module ?? ''))
    return false;
  if (subscription.patterns?.length) {
    return subscription.patterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(event.message);
    });
  }
  return true;
}

export function selectEvidenceKind(event: StructuredLogEvent): EvidenceKind {
  if (event.metadata.processEvent === 'uncaughtException') return 'uncaught_exception';
  if (event.metadata.processEvent === 'unhandledRejection') return 'runtime_crash';
  if (event.level === 'fatal') return 'runtime_crash';
  if (event.level === 'warn') return 'runtime_warning';
  return 'daemon_error';
}

export function summarizeLogEvent(event: StructuredLogEvent): string {
  const stackLine = event.stack?.split('\n').find((line) => line.trim().length > 0);
  const suffix = stackLine ? ` — ${stackLine.trim()}` : '';
  return redactString(`${event.level.toUpperCase()}: ${event.message}${suffix}`).slice(0, 500);
}

export function fingerprintLogEvent(event: StructuredLogEvent): string {
  const base = [
    event.level,
    event.module ?? '',
    event.metadata.processEvent ?? '',
    normalizeForFingerprint(event.message),
    event.stack?.split('\n')[0] ?? '',
  ].join('|');
  return hashString(base);
}

function normalizeForFingerprint(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{10,}\b/g, '<number>')
    .replace(/\/tmp\/[^\s]+/g, '/tmp/<path>')
    .slice(0, 1000);
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
