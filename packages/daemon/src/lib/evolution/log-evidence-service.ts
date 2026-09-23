import type { StructuredLogEvent, StructuredLogLevel } from '@hyperneo/shared';
import { isSqliteBusyError } from '../../storage/busy-retry.ts';
import type {
  DrainItem,
  EvolutionLogEvidenceServiceDeps,
  LogEvidenceSubscription,
} from './log-evidence-types.ts';
import { fingerprintLogEvent, matchesSubscription } from './log-event-classification.ts';
import { findExistingEvidence, writeMatchedEvidence } from './log-evidence-writer.ts';

export type {
  EvolutionLogEvidenceServiceDeps,
  LogEvidenceSubscription,
} from './log-evidence-types.ts';

export const PRODUCT_EVOLUTION_SCOPE_ID = 'f4ace1c5-f1b5-4fa7-88b4-6717ab70cfe0';

const DEFAULT_SUBSCRIPTION_REFRESH_MS = 30 * 1000;
const DEFAULT_MAX_BUFFERED_EVENTS = 500;
const DEFAULT_FLUSH_DELAY_MS = 1000;
const BUSY_RETRY_BASE_MS = 1000;
const MAX_BUSY_RETRY_MS = 30 * 1000;
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
    const budget = this.deps.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    let writes = 0;
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
          if (!isSqliteBusyError(error)) {
            await yieldToEventLoop();
            continue;
          }
          this.buffer.unshift(event);
          this.busyRetryCount += 1;
          this.retryDelayMs = Math.min(
            BUSY_RETRY_BASE_MS * 2 ** (this.busyRetryCount - 1),
            MAX_BUSY_RETRY_MS
          );
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
        if (writes >= budget) {
          await yieldToEventLoop();
          return;
        }
        try {
          await this.writeEvidenceInterleaved(item, item.subscriptions[item.offset]);
          writes += 1;
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
      for (let i = interrupted.offset; i < interrupted.subscriptions.length; i++) {
        try {
          this.writeEvidence(interrupted.event, interrupted.subscriptions[i]);
        } catch (error) {
          if (!isSqliteBusyError(error)) continue;
          busyHit = true;
          this.drainItem = {
            event: interrupted.event,
            subscriptions: interrupted.subscriptions,
            offset: i,
          };
          break;
        }
      }
    }
    const batch = this.buffer.splice(0);
    if (batch.length > 0 && this.drainItem !== null) {
      for (let remain = batch.length - 1; remain >= 0; remain--) {
        this.buffer.unshift(batch[remain]);
      }
    } else if (batch.length > 0) {
      try {
        const subscriptions = this.getSubscriptions();
        for (let index = 0; index < batch.length; index++) {
          const event = batch[index];
          let eventBusy = false;
          for (const subscription of subscriptions) {
            if (!matchesSubscription(subscription, event)) continue;
            try {
              this.writeEvidence(event, subscription);
            } catch (error) {
              if (isSqliteBusyError(error)) {
                busyHit = true;
                eventBusy = true;
                break;
              }
            }
          }
          if (eventBusy) {
            for (let remain = batch.length - 1; remain >= index; remain--) {
              this.buffer.unshift(batch[remain]);
            }
            break;
          }
        }
      } catch (error) {
        if (isSqliteBusyError(error)) {
          busyHit = true;
          for (let remain = batch.length - 1; remain >= 0; remain--) {
            this.buffer.unshift(batch[remain]);
          }
        }
      }
    }
    if (busyHit) {
      this.busyRetryCount += 1;
      this.retryDelayMs = Math.min(
        BUSY_RETRY_BASE_MS * 2 ** (this.busyRetryCount - 1),
        MAX_BUSY_RETRY_MS
      );
      this.scheduleDrain();
      return;
    }
    this.busyRetryCount = 0;
    this.retryDelayMs = null;
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
    const existing = findExistingEvidence(
      this.deps.evolutionRepo,
      subscription.scopeId,
      `log:${fingerprint}`,
      fingerprint
    );
    writeMatchedEvidence(
      this.deps.evolutionRepo,
      this.deps.dedupeWindowMs,
      event,
      subscription.scopeId,
      fingerprint,
      existing
    );
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
    const existing = findExistingEvidence(
      this.deps.evolutionRepo,
      subscription.scopeId,
      `log:${fingerprint}`,
      fingerprint
    );
    if (!(await this.continueDrain(item))) return;
    writeMatchedEvidence(
      this.deps.evolutionRepo,
      this.deps.dedupeWindowMs,
      event,
      subscription.scopeId,
      fingerprint,
      existing
    );
  }

  private async continueDrain(item: DrainItem): Promise<boolean> {
    await yieldToEventLoop();
    return this.drainItem === item;
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
    const fixedScope = this.deps.evolutionRepo.getScope(PRODUCT_EVOLUTION_SCOPE_ID);
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
          'Capture daemon runtime warnings, errors, and crashes for product Evolution evidence.',
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
