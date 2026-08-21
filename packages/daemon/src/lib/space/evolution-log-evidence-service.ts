import type {
  EvidenceKind,
  EvidenceRef,
  StructuredLogEvent,
  StructuredLogLevel,
} from '@hyperneo/shared';
import type { EvolutionRepository } from '../../storage/repositories/evolution-repository';
import type { SpaceRepository } from '../../storage/repositories/space-repository';

export const PRODUCT_FORGE_SCOPE_ID = 'f4ace1c5-f1b5-4fa7-88b4-6717ab70cfe0';

export interface LogEvidenceSubscription {
  scopeId: string;
  levels: StructuredLogLevel[];
  modules?: string[];
  patterns?: RegExp[];
}

export interface EvolutionLogEvidenceServiceDeps {
  evolutionRepo: EvolutionRepository;
  spaceRepo?: Pick<SpaceRepository, 'listSpaces'>;
  subscriptions?: LogEvidenceSubscription[];
  dedupeWindowMs?: number;
  maxBufferedEvents?: number;
  subscriptionRefreshMs?: number;
}

type LogEvidenceRepository = EvolutionRepository & {
  findLatestEvidenceBySource?: (scopeId: string, sourceId: string) => EvidenceRef | null;
};

interface BufferedEvent {
  event: StructuredLogEvent;
  subscription: LogEvidenceSubscription;
  fingerprint: string;
}

const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_SUBSCRIPTION_REFRESH_MS = 30 * 1000;
const DEFAULT_MAX_BUFFERED_EVENTS = 500;
const MAX_SAMPLES = 5;

export class EvolutionLogEvidenceService {
  private buffer: BufferedEvent[] = [];
  private cachedDefaultSubscriptions: LogEvidenceSubscription[] = [];
  private nextSubscriptionRefreshAt = 0;

  constructor(private deps: EvolutionLogEvidenceServiceDeps) {}

  capture(event: StructuredLogEvent): void {
    for (const subscription of this.getSubscriptions()) {
      if (!matchesSubscription(subscription, event)) continue;
      this.buffer.push({
        event,
        subscription,
        fingerprint: fingerprintLogEvent(event),
      });
    }
    const max = this.deps.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    if (this.buffer.length > max) this.buffer.splice(0, this.buffer.length - max);
  }

  flush(): void {
    const batch = this.buffer.splice(0);
    for (const item of batch) {
      try {
        this.writeEvidence(item);
      } catch {}
    }
  }

  private writeEvidence(item: BufferedEvent): void {
    const scope = this.deps.evolutionRepo.getScope(item.subscription.scopeId);
    if (!scope) return;
    const now = item.event.timestamp;
    const kind = selectEvidenceKind(item.event);
    const sourceId = `log:${item.fingerprint}`;
    const existing = this.findExistingEvidence(
      item.subscription.scopeId,
      sourceId,
      item.fingerprint
    );
    const summary = summarizeLogEvent(item.event);
    if (existing) {
      const firstSeenAt = numberOr(existing.metadata.firstSeenAt, now);
      const lastSeenAt = numberOr(existing.metadata.lastSeenAt, firstSeenAt);
      if (now - lastSeenAt <= (this.deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS)) {
        this.deps.evolutionRepo.updateEvidence(existing.id, {
          summary,
          metadata: buildMetadata(item.event, item.fingerprint, {
            count: numberOr(existing.metadata.count, 1) + 1,
            firstSeenAt,
            previousSamples: Array.isArray(existing.metadata.samples)
              ? existing.metadata.samples
              : [],
          }),
        });
        return;
      }
    }
    this.deps.evolutionRepo.createEvidence({
      scopeId: item.subscription.scopeId,
      kind,
      sourceId,
      summary,
      metadata: buildMetadata(item.event, item.fingerprint, {
        count: 1,
        firstSeenAt: now,
        previousSamples: [],
      }),
      createdAt: now,
    });
  }

  private findExistingEvidence(scopeId: string, sourceId: string, fingerprint: string) {
    const repo = this.deps.evolutionRepo as LogEvidenceRepository;
    const candidate = repo.findLatestEvidenceBySource
      ? repo.findLatestEvidenceBySource(scopeId, sourceId)
      : repo.listEvidence(scopeId).find((evidence) => evidence.sourceId === sourceId);
    if (
      candidate?.metadata.autoCaptured === true &&
      candidate.metadata.logFingerprint === fingerprint
    ) {
      return candidate;
    }
    return undefined;
  }

  private getSubscriptions(): LogEvidenceSubscription[] {
    if (this.deps.subscriptions) return this.deps.subscriptions;
    const now = Date.now();
    if (now >= this.nextSubscriptionRefreshAt) {
      this.cachedDefaultSubscriptions = this.resolveDefaultProductScopes().map((scopeId) => ({
        scopeId,
        levels: ['warn', 'error', 'fatal'] as StructuredLogLevel[],
      }));
      this.nextSubscriptionRefreshAt =
        now + (this.deps.subscriptionRefreshMs ?? DEFAULT_SUBSCRIPTION_REFRESH_MS);
    }
    return this.cachedDefaultSubscriptions;
  }

  private resolveDefaultProductScopes(): string[] {
    const fixedScope = this.deps.evolutionRepo.getScope(PRODUCT_FORGE_SCOPE_ID);
    if (fixedScope) return [fixedScope.id];
    const spaces = this.deps.spaceRepo?.listSpaces(false) ?? [];
    return spaces
      .flatMap((space) =>
        typeof space.id === 'string' ? [this.findOrCreateProductScope(space.id)] : []
      )
      .filter((scopeId): scopeId is string => scopeId !== null);
  }

  private findOrCreateProductScope(spaceId: string): string | null {
    const existing = this.deps.evolutionRepo
      .listScopes({ spaceId })
      .find((scope) => scope.policy.logEvidenceProductScope === true);
    if (existing) return existing.id;
    try {
      return this.deps.evolutionRepo.createScope({
        spaceId,
        kind: 'project',
        name: 'HyperNeo product runtime evidence',
        objective:
          'Capture daemon runtime warnings, errors, and crashes for product Forge evidence.',
        policy: { logEvidenceProductScope: true },
      }).id;
    } catch {
      return null;
    }
  }
}

function matchesSubscription(
  subscription: LogEvidenceSubscription,
  event: StructuredLogEvent
): boolean {
  if (!subscription.levels.includes(event.level)) return false;
  if (subscription.modules?.length && !subscription.modules.includes(event.module ?? ''))
    return false;
  if (subscription.patterns?.length) {
    return subscription.patterns.some((pattern) => pattern.test(event.message));
  }
  return true;
}

function selectEvidenceKind(event: StructuredLogEvent): EvidenceKind {
  if (event.metadata.processEvent === 'uncaughtException') return 'uncaught_exception';
  if (event.metadata.processEvent === 'unhandledRejection') return 'runtime_crash';
  if (event.level === 'fatal') return 'runtime_crash';
  if (event.level === 'warn') return 'runtime_warning';
  return 'daemon_error';
}

function summarizeLogEvent(event: StructuredLogEvent): string {
  const stackLine = event.stack?.split('\n').find((line) => line.trim().length > 0);
  const suffix = stackLine ? ` — ${stackLine.trim()}` : '';
  return redactString(`${event.level.toUpperCase()}: ${event.message}${suffix}`).slice(0, 500);
}

function fingerprintLogEvent(event: StructuredLogEvent): string {
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

function buildMetadata(
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

function numberOr(value: unknown, fallback: number): number {
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

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, '$1=[REDACTED]');
}
