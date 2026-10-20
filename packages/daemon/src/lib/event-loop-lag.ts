import { createLagSamplingProfiler, type LagSamplingTick } from './event-loop-sampling.ts';
import { loadRuntimeSamplingProfiler } from './runtime-sampling-profiler.ts';
import { EventLoopActivity, observeLagGc } from './event-loop-activity.ts';
import { emitStructuredLogEvent, subscribeToStructuredLogs } from './logger.ts';
import type { MessageHub } from '@hyperneo/shared';
import { takeSlowestQuery } from '../storage/sqlite-query-observability.ts';

export const EVENT_LOOP_LAG_TICK_MS = 250;
export const EVENT_LOOP_LAG_WARN_MS = 1_000;

type SlowestQuery = { durationMs: number; sql: string } | null;

export function describeEventLoopLag(
  lagMs: number,
  slowest: SlowestQuery,
  warnMs = EVENT_LOOP_LAG_WARN_MS
): string | null {
  if (lagMs < warnMs) return null;
  const sql = slowest
    ? `; slowest SQL ${Math.round(slowest.durationMs)}ms: ${slowest.sql.slice(0, 300)}`
    : '';
  return `[Daemon] Event loop blocked for ${Math.round(lagMs)}ms${sql}`;
}

export function startEventLoopLagLog(
  warn: (line: string) => void,
  deps: {
    now?: () => number;
    takeSlowest?: () => SlowestQuery;
    tickMs?: number;
    activity?: EventLoopActivity;
    sampleHeap?: () => number;
    onDiagnostic?: (report: Record<string, unknown>) => void;
    sampleStacks?: LagSamplingTick;
  } = {}
): () => void {
  const now = deps.now ?? (() => performance.now());
  const takeSlowest = deps.takeSlowest ?? takeSlowestQuery;
  const tickMs = deps.tickMs ?? EVENT_LOOP_LAG_TICK_MS;
  takeSlowest();
  const activity = deps.activity ?? new EventLoopActivity(now);
  const deactivate = activity.activate();
  const gc = observeLagGc(activity);
  const sampleHeap = deps.sampleHeap ?? (() => process.memoryUsage().heapUsed);
  let normalHeapSampling = true;
  const heap = (): number | undefined => {
    const started = performance.now();
    try {
      return sampleHeap();
    } catch {
      return undefined;
    } finally {
      if (performance.now() - started > 1) normalHeapSampling = false;
    }
  };
  let beforeHeap = heap();
  let last = now();
  let heapAt = last;
  const timer = setInterval(() => {
    const at = now();
    const lagMs = at - last - tickMs;
    const line = describeEventLoopLag(lagMs, takeSlowest());
    gc.flush();
    const recent = activity.drain(last);
    const afterHeap = line || normalHeapSampling ? heap() : undefined;
    const samplingProfile = deps.sampleStacks?.(line !== null, at);
    if (line) {
      warn(line);
      const report = {
        lagMs,
        ...(samplingProfile ? { samplingProfile } : {}),
        tickStartMs: last,
        tickEndMs: at,
        activities: recent.entries,
        droppedActivities: recent.dropped,
        gcObservation: gc.status,
        heapBeforeBytes: beforeHeap,
        heapAfterBytes: afterHeap,
        heapDeltaBytes:
          beforeHeap === undefined || afterHeap === undefined ? undefined : afterHeap - beforeHeap,
        heapBeforeAgeMs: at - heapAt,
        heapSampling: normalHeapSampling ? 'each_tick' : 'blocks_only',
      };
      if (deps.onDiagnostic) deps.onDiagnostic(report);
      else
        emitStructuredLogEvent({
          level: 'warn',
          args: ['event_loop.lag_activity'],
          source: 'logger',
          module: 'hyperneo:daemon:event-loop-lag',
          metadata: report,
        });
    }
    if (afterHeap !== undefined) {
      beforeHeap = afterHeap;
      heapAt = at;
    }
    last = at;
  }, tickMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    gc.stop();
    deactivate();
  };
}

export function startDaemonLagDiagnostics(
  hub: Pick<MessageHub, 'onMessage'>,
  warn: (line: string) => void
): () => void {
  const activity = new EventLoopActivity();
  const offRpc = hub.onMessage((message, direction) => {
    if (message.type === 'REQ' || message.type === 'RSP')
      activity.record(`rpc.${direction}:${message.method}`);
  });
  const offLogs = subscribeToStructuredLogs((event) => {
    const module = event.module?.match(/^hyperneo:daemon:[a-z0-9_-]+/)?.[0];
    if (module && module !== 'hyperneo:daemon:event-loop-lag')
      activity.record(
        `${module}:${typeof event.metadata.event === 'string' ? event.metadata.event : 'log'}`
      );
  });
  let stopped = false;
  let sampleStacks: LagSamplingTick | undefined;
  if (process.env.HYPERNEO_LAG_PROFILE === '1') {
    sampleStacks = () => ({ status: 'starting' });
    void loadRuntimeSamplingProfiler(() => !stopped).then(
      (read) => {
        if (!stopped)
          sampleStacks = read
            ? createLagSamplingProfiler(read, performance.now()).tick
            : () => ({ status: 'unsupported' });
      },
      () => {
        if (!stopped) sampleStacks = () => ({ status: 'failed' });
      }
    );
  }
  const stop = startEventLoopLagLog(warn, {
    activity,
    sampleStacks: (blocked, at) => sampleStacks?.(blocked, at),
  });
  return () => {
    stopped = true;
    offRpc();
    offLogs();
    stop();
  };
}
