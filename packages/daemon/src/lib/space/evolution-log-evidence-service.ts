import type {
  EvidenceKind,
  EvidenceRef,
  StructuredLogEvent,
  StructuredLogLevel,
} from '@hyperneo/shared';
import { isSqliteBusyError } from '../../storage/busy-retry';
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
  flushDelayMs?: number;
}

type LogEvidenceRepository = EvolutionRepository & {
  findLatestEvidenceBySource?: (scopeId: string, sourceId: string) => EvidenceRef | null;
};

interface DrainItem {
  event: StructuredLogEvent;
  subscriptions: LogEvidenceSubscription[];
  offset: number;
}

const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_SUBSCRIPTION_REFRESH_MS = 30 * 1000;
const DEFAULT_MAX_BUFFERED_EVENTS = 500;
const DEFAULT_FLUSH_DELAY_MS = 1000;
const BUSY_RETRY_BASE_MS = 1000;
const MAX_BUSY_RETRY_MS = 30 * 1000;
const MAX_SAMPLES = 5;
const DEFAULT_CAPTURE_LEVELS: ReadonlySet<StructuredLogLevel> = new Set(['warn', 'error', 'fatal']);

export class EvolutionLogEvidenceService {
  private buffer: StructuredLogEvent[] = [];
  private cachedDefaultSubscriptions: LogEvidenceSubscription[] = [];
  private nextSubscriptionRefreshAt = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private drainItem: DrainItem | null = null;
  private retryDelayMs: number | null = null;
  private busyRetryCount = 0;

  constructor(private deps: EvolutionLogEvidenceServiceDeps) {}

  capture(event: StructuredLogEvent): void {
    if (this.deps.subscriptions) {
      if (!this.deps.subscriptions.some((s) => matchesSubscription(s, event))) return;
    } else if (!DEFAULT_CAPTURE_LEVELS.has(event.level)) {
      return;
    }
    this.buffer.push(event);
    this.scheduleDrain();
    const max = this.deps.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    if (this.buffer.length > max) this.buffer.splice(0, this.buffer.length - max);
  }

  scheduleDrain(): void {
    if (this.drainTimer !== null || this.drainPromise !== null) return;
    const delay = this.retryDelayMs ?? this.deps.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.retryDelayMs = null;
    const timer = setTimeout(() => {
      this.drainTimer = null;
      void this.flushAsync();
    }, delay);
    timer.unref?.();
    this.drainTimer = timer;
  }

  flushAsync(): Promise<void> {
    this.cancelScheduledDrain();
    this.drainPromise ??= this.drainBuffer()
      .catch(() => {})
      .finally(() => {
        this.drainPromise = null;
        if (this.buffer.length > 0 || this.drainItem !== null) this.scheduleDrain();
      });
    return this.drainPromise;
  }

  private async drainBuffer(): Promise<void> {
    while (true) {
      if (this.drainItem === null) {
        const event = this.buffer.shift();
        if (event === undefined) break;
        let subscriptions: LogEvidenceSubscription[];
        try {
          subscriptions = this.getSubscriptions().filter((candidate) =>
            matchesSubscription(candidate, event)
          );
        } catch (error) {
          this.buffer.unshift(event);
          if (isSqliteBusyError(error)) {
            this.busyRetryCount += 1;
            this.retryDelayMs = Math.min(
              BUSY_RETRY_BASE_MS * 2 ** (this.busyRetryCount - 1),
              MAX_BUSY_RETRY_MS
            );
          }
          return;
        }
        if (subscriptions.length === 0) {
          await yieldToEventLoop();
          continue;
        }
        this.drainItem = { event, subscriptions, offset: 0 };
      }
      const item = this.drainItem;
      while (item.offset < item.subscriptions.length) {
        try {
          await this.writeEvidenceInterleaved(item, item.subscriptions[item.offset]);
        } catch (error) {
          if (this.drainItem !== item) return;
          if (!isSqliteBusyError(error)) {
            item.offset += 1;
            continue;
          }
          this.busyRetryCount += 1;
          this.retryDelayMs = Math.min(
            BUSY_RETRY_BASE_MS * 2 ** (this.busyRetryCount - 1),
            MAX_BUSY_RETRY_MS
          );
          return;
        }
        if (this.drainItem !== item) return;
        item.offset += 1;
        this.busyRetryCount = 0;
        await yieldToEventLoop();
        if (this.drainItem !== item) return;
      }
      this.drainItem = null;
      await yieldToEventLoop();
    }
  }

  flush(): void {
    this.cancelScheduledDrain();
    let busyHit = false;
    const interrupted = this.drainItem;
    if (interrupted !== null) {
      this.drainItem = null;
      for (const subscription of interrupted.subscriptions.slice(interrupted.offset)) {
        try {
          this.writeEvidence(interrupted.event, subscription);
        } catch (error) {
          if (isSqliteBusyError(error)) busyHit = true;
        }
      }
    }
    const batch = this.buffer.splice(0);
    if (batch.length > 0) {
      try {
        const subscriptions = this.getSubscriptions();
        for (const event of batch) {
          for (const subscription of subscriptions) {
            if (!matchesSubscription(subscription, event)) continue;
            try {
              this.writeEvidence(event, subscription);
            } catch (error) {
              if (isSqliteBusyError(error)) busyHit = true;
            }
          }
        }
      } catch {}
    }
    if (!busyHit) {
      this.busyRetryCount = 0;
      this.retryDelayMs = null;
    }
  }

  private cancelScheduledDrain(): void {
    if (this.drainTimer === null) return;
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  private writeEvidence(event: StructuredLogEvent, subscription: LogEvidenceSubscription): void {
    const fingerprint = fingerprintLogEvent(event);
    const scope = this.deps.evolutionRepo.getScope(subscription.scopeId);
    if (!scope) return;
    const existing = this.findExistingEvidence(
      subscription.scopeId,
      `log:${fingerprint}`,
      fingerprint
    );
    this.writeMatchedEvidence(event, subscription.scopeId, fingerprint, existing);
  }

  private async writeEvidenceInterleaved(
    item: DrainItem,
    subscription: LogEvidenceSubscription
  ): Promise<void> {
    const event = item.event;
    const fingerprint = fingerprintLogEvent(event);
    const scope = this.deps.evolutionRepo.getScope(subscription.scopeId);
    if (!(await this.continueDrain(item))) return;
    if (!scope) return;
    const existing = this.findExistingEvidence(
      subscription.scopeId,
      `log:${fingerprint}`,
      fingerprint
    );
    if (!(await this.continueDrain(item))) return;
    this.writeMatchedEvidence(event, subscription.scopeId, fingerprint, existing);
  }

  private async continueDrain(item: DrainItem): Promise<boolean> {
    await yieldToEventLoop();
    return this.drainItem === item;
  }

  private writeMatchedEvidence(
    event: StructuredLogEvent,
    scopeId: string,
    fingerprint: string,
    existing: EvidenceRef | undefined
  ): void {
    const now = event.timestamp;
    const kind = selectEvidenceKind(event);
    const summary = summarizeLogEvent(event);
    if (existing) {
      const firstSeenAt = numberOr(existing.metadata.firstSeenAt, now);
      const lastSeenAt = numberOr(existing.metadata.lastSeenAt, firstSeenAt);
      if (now - lastSeenAt <= (this.deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS)) {
        this.deps.evolutionRepo.updateEvidence(existing.id, {
          summary,
          metadata: buildMetadata(event, fingerprint, {
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
      scopeId,
      kind,
      sourceId: `log:${fingerprint}`,
      summary,
      metadata: buildMetadata(event, fingerprint, {
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function matchesSubscription(
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
