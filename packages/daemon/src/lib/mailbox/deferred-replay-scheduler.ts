import superpipe, { type PipelineAPI } from 'superpipe';
import type { AgentSession } from '../agent/agent-session.ts';
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
    status === 'interrupted' ||
    status === 'rate_limit_cooldown'
  );
}

function isUnavailableStatus(status: string): boolean {
  return (
    status === 'ended' ||
    status === 'archived' ||
    status === 'pending_worktree_choice' ||
    status === 'paused'
  );
}

export type ReplaySkipReason = 'no_cached_session' | 'manual_mode' | 'session_unavailable';

export function gateSessionPresent(
  session: AgentSession | null
): { value: AgentSession } | { reason: ReplaySkipReason } {
  if (session == null) return { reason: 'no_cached_session' };
  return { value: session };
}

export function gateQueryMode(
  session: AgentSession
): { value: AgentSession } | { reason: ReplaySkipReason } {
  if (session.getSessionData().config.queryMode === 'manual') return { reason: 'manual_mode' };
  return { value: session };
}

export function gateLifecycleStatus(
  session: AgentSession
): { value: AgentSession } | { reason: ReplaySkipReason } {
  if (isUnavailableStatus(session.getSessionData().status ?? '')) {
    return { reason: 'session_unavailable' };
  }
  return { value: session };
}

export const decideReplayAdmission = (
  superpipe({})('mailbox-deferred-replay-admission') as PipelineAPI
)
  .input(['session'])
  .pipe(gateSessionPresent, 'session', 'result:admission')
  .pipe(gateQueryMode, 'admission', 'result:admission')
  .pipe(gateLifecycleStatus, 'admission', 'result:admission')
  .end('admission') as (session: AgentSession | null) => AgentSession | ReplaySkipReason;

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
  const ready = new Set<string>();
  const tracked = new Set<string>();
  const dirty = new Set<string>();
  const cancelled = new Set<string>();
  const attempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const parkedWaiters = new Map<string, () => void>();

  let pumpScheduled = false;
  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    setImmediate(() => {
      pumpScheduled = false;
      pump();
    });
  };

  const pump = (): void => {
    let admitted = 0;
    for (const sessionId of ready) {
      if (active.size >= MAX_ACTIVE_PUBLICATIONS) break;
      if (admitted >= MAX_ACTIVE_PUBLICATIONS) {
        schedulePump();
        return;
      }
      ready.delete(sessionId);
      active.add(sessionId);
      admitted += 1;
      void runSession(sessionId);
    }
  };

  const cleanup = (sessionId: string): void => {
    tracked.delete(sessionId);
    dirty.delete(sessionId);
    cancelled.delete(sessionId);
    attempts.delete(sessionId);
  };

  const exitIfCancelled = (sessionId: string, event: string): boolean => {
    if (!cancelled.has(sessionId)) return false;
    emitReplayEvent(event, { sessionId });
    cleanup(sessionId);
    return true;
  };

  const skipReplay = (sessionId: string, reason: ReplaySkipReason): void => {
    emitReplayEvent('skipped', { sessionId, reason });
    cleanup(sessionId);
  };

  const admitSession = (sessionId: string, fetched: AgentSession | null): AgentSession | null => {
    const admission = decideReplayAdmission(fetched);
    if (typeof admission === 'string') {
      skipReplay(sessionId, admission);
      return null;
    }
    return admission;
  };

  const runSession = async (sessionId: string): Promise<void> => {
    let retryDelayMs: number | null = null;
    let parkedForIdle = false;
    try {
      if (exitIfCancelled(sessionId, 'cancelled_before_run')) return;
      let session = admitSession(
        sessionId,
        deps.sessionManager?.getCachedSession(sessionId) ?? null
      );
      if (session == null) return;
      let status = session.getProcessingState().status;
      while (isBusyStatus(status) || session.stateManager.isTerminalIdleInFlight?.()) {
        if (status === 'interrupted') {
          await session.normalizeStaleInterruptedState?.();
          const normalized = deps.sessionManager?.getCachedSession(sessionId) ?? null;
          if (normalized == null) {
            skipReplay(sessionId, 'no_cached_session');
            return;
          }
          if (normalized !== session) {
            session = normalized;
            emitReplayEvent('session_replaced', { sessionId });
          }
          const normalizedStatus = session.getProcessingState().status;
          if (normalizedStatus !== 'interrupted') {
            status = normalizedStatus;
            continue;
          }
          if (exitIfCancelled(sessionId, 'cancelled_before_park')) return;
        }
        emitReplayEvent('idle_wait_registered', { sessionId, status });
        active.delete(sessionId);
        const waiter = session.stateManager.waitForIdleTransition();
        parkedWaiters.set(sessionId, waiter.cancel);
        parkedForIdle = true;
        schedulePump();
        await waiter.promise;
        parkedWaiters.delete(sessionId);
        parkedForIdle = false;
        if (exitIfCancelled(sessionId, 'cancelled_after_idle_wait')) return;
        if (active.size >= MAX_ACTIVE_PUBLICATIONS) {
          ready.add(sessionId);
          return;
        }
        active.add(sessionId);
        const current = deps.sessionManager?.getCachedSession(sessionId) ?? null;
        if (current == null) {
          skipReplay(sessionId, 'no_cached_session');
          return;
        }
        if (current !== session) {
          session = current;
          emitReplayEvent('session_replaced', { sessionId });
        }
        status = session.getProcessingState().status;
        emitReplayEvent('idle_wait_resolved', { sessionId, status });
      }
      if (exitIfCancelled(sessionId, 'cancelled_before_publish')) return;
      session = admitSession(sessionId, session);
      if (session == null) return;
      const published = await deps.internalEventBus.publish('query.trigger', { sessionId });
      if (published != null && published.delivered < 1) {
        emitReplayEvent('no_subscribers', { sessionId });
        throw new Error('query.trigger delivered to no subscribers');
      }
      emitReplayEvent('published', { sessionId });
      attempts.delete(sessionId);
      tracked.delete(sessionId);
      if (cancelled.delete(sessionId)) {
        dirty.delete(sessionId);
        emitReplayEvent('cancelled_after_publish', { sessionId });
        return;
      }
      if (dirty.delete(sessionId)) {
        ready.add(sessionId);
        tracked.add(sessionId);
        schedulePump();
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
      schedulePump();
      if (retryDelayMs !== null) {
        const delay = retryDelayMs;
        if (cancelled.has(sessionId)) {
          cleanup(sessionId);
        } else {
          const timer = setTimeout(() => {
            retryTimers.delete(sessionId);
            dirty.delete(sessionId);
            ready.add(sessionId);
            pump();
          }, delay);
          retryTimers.set(sessionId, timer);
        }
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
      cancelled.delete(sessionId);
      ready.add(sessionId);
      schedulePump();
    },
    cancel(sessionId: string): void {
      if (!tracked.has(sessionId)) return;
      if (ready.delete(sessionId)) {
        cleanup(sessionId);
        return;
      }
      const timer = retryTimers.get(sessionId);
      if (timer != null) {
        clearTimeout(timer);
        retryTimers.delete(sessionId);
        cleanup(sessionId);
        return;
      }
      const waiterCancel = parkedWaiters.get(sessionId);
      if (waiterCancel != null) waiterCancel();
      cancelled.add(sessionId);
    },
  };
}
