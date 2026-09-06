import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { emitStructuredLogEvent } from '../logger.ts';
import type { SessionManager } from '../session-manager.ts';

const MAX_ACTIVE_PUBLICATIONS = 8;
const RETRY_BACKOFF_BASE_MS = 500;
const RETRY_BACKOFF_CAP_MS = 60_000;

function emitReplayEvent(
  event: string,
  fields: Record<string, string | number | boolean | null>
): void {
  try {
    emitStructuredLogEvent({
      level: 'info',
      args: ['mailbox.deferred_replay'],
      source: 'logger',
      module: 'hyperneo:daemon:mailbox:deferred-replay',
      metadata: { event, ...fields },
    });
  } catch {}
}

function isBusyStatus(status: string): boolean {
  return (
    status === 'processing' ||
    status === 'queued' ||
    status === 'waiting_for_input' ||
    status === 'interrupted'
  );
}

export interface MailboxDeferredReplaySchedulerDeps {
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  sessionManager: Pick<SessionManager, 'getCachedSession'> | null;
  retryBackoffBaseMs?: number;
  retryBackoffCapMs?: number;
}

export interface MailboxDeferredReplayScheduler {
  schedule(sessionId: string): void;
  cancel(sessionId: string): void;
}

export function createMailboxDeferredReplayScheduler(
  deps: MailboxDeferredReplaySchedulerDeps
): MailboxDeferredReplayScheduler {
  const retryBackoffBaseMs = deps.retryBackoffBaseMs ?? RETRY_BACKOFF_BASE_MS;
  const retryBackoffCapMs = deps.retryBackoffCapMs ?? RETRY_BACKOFF_CAP_MS;
  const active = new Set<string>();
  const ready: string[] = [];
  const tracked = new Set<string>();
  const dirty = new Set<string>();
  const cancelled = new Set<string>();
  const attempts = new Map<string, number>();

  const pump = (): void => {
    while (active.size < MAX_ACTIVE_PUBLICATIONS && ready.length > 0) {
      const sessionId = ready.shift()!;
      active.add(sessionId);
      void runSession(sessionId);
    }
  };

  const runSession = async (sessionId: string): Promise<void> => {
    let retryDelayMs: number | null = null;
    let parkedForIdle = false;
    try {
      if (cancelled.has(sessionId)) {
        emitReplayEvent('cancelled_before_run', { sessionId });
        cancelled.delete(sessionId);
        tracked.delete(sessionId);
        dirty.delete(sessionId);
        return;
      }
      const session = deps.sessionManager?.getCachedSession(sessionId);
      if (!session) {
        emitReplayEvent('skipped', { sessionId, reason: 'no_cached_session' });
        tracked.delete(sessionId);
        dirty.delete(sessionId);
        return;
      }
      if (session.getSessionData().config.queryMode === 'manual') {
        emitReplayEvent('skipped', { sessionId, reason: 'manual_mode' });
        tracked.delete(sessionId);
        dirty.delete(sessionId);
        return;
      }
      let status = session.getProcessingState().status;
      while (isBusyStatus(status)) {
        emitReplayEvent('idle_wait_registered', { sessionId, status });
        active.delete(sessionId);
        parkedForIdle = true;
        await session.stateManager.waitForIdleTransition().promise;
        parkedForIdle = false;
        if (cancelled.has(sessionId)) {
          emitReplayEvent('cancelled_after_idle_wait', { sessionId });
          cancelled.delete(sessionId);
          tracked.delete(sessionId);
          dirty.delete(sessionId);
          return;
        }
        if (active.size >= MAX_ACTIVE_PUBLICATIONS) {
          ready.push(sessionId);
          return;
        }
        active.add(sessionId);
        status = session.getProcessingState().status;
        emitReplayEvent('idle_wait_resolved', { sessionId, status });
      }
      await deps.internalEventBus.publish('query.trigger', { sessionId });
      emitReplayEvent('published', { sessionId });
      attempts.delete(sessionId);
      tracked.delete(sessionId);
      if (cancelled.delete(sessionId)) {
        dirty.delete(sessionId);
        emitReplayEvent('cancelled_after_publish', { sessionId });
        return;
      }
      if (dirty.delete(sessionId)) {
        ready.push(sessionId);
        tracked.add(sessionId);
        setImmediate(pump);
      }
    } catch (error) {
      const count = (attempts.get(sessionId) ?? 0) + 1;
      attempts.set(sessionId, count);
      retryDelayMs = Math.min(retryBackoffBaseMs * 2 ** (count - 1), retryBackoffCapMs);
      emitReplayEvent('publish_failed', {
        sessionId,
        attempt: count,
        retryDelayMs,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!parkedForIdle) active.delete(sessionId);
      pump();
      if (retryDelayMs !== null) {
        const delay = retryDelayMs;
        setTimeout(() => {
          dirty.delete(sessionId);
          if (!ready.includes(sessionId)) ready.push(sessionId);
          pump();
        }, delay);
      }
    }
  };

  return {
    schedule(sessionId: string): void {
      if (tracked.has(sessionId)) {
        dirty.add(sessionId);
        cancelled.delete(sessionId);
        return;
      }
      tracked.add(sessionId);
      attempts.delete(sessionId);
      ready.push(sessionId);
      setImmediate(pump);
    },
    cancel(sessionId: string): void {
      if (!tracked.has(sessionId)) return;
      const index = ready.indexOf(sessionId);
      if (index >= 0) {
        ready.splice(index, 1);
        tracked.delete(sessionId);
        dirty.delete(sessionId);
        return;
      }
      cancelled.add(sessionId);
    },
  };
}
