import { createLagSamplingProfiler, type LagSamplingTick } from './event-loop-sampling.ts';
import { loadRuntimeSamplingProfiler } from './runtime-sampling-profiler.ts';
import { EventLoopActivity, observeLagGc } from './event-loop-activity.ts';
import { emitStructuredLogEvent, subscribeToStructuredLogs } from './logger.ts';
import type { MessageHub } from '@hyperneo/shared';
import { collectSlowQueryTicks, takeSlowestQuery } from '../storage/sqlite-query-observability.ts';

export const EVENT_LOOP_LAG_TICK_MS = 250;
export const EVENT_LOOP_LAG_WARN_MS = 1_000;

type SlowestQuery = { durationMs: number; sql: string } | null;
type ResourceSample = {
  cpuMs: number;
  cpuSampler: 'thread' | 'process';
  majorFaults: number;
  blockWrites: number;
  voluntarySwitches: number;
};

function sampleProcessResources(): ResourceSample | undefined {
  try {
    const usage = process.resourceUsage();
    const thread = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage?.();
    const cpu = thread ?? process.cpuUsage();
    return {
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuSampler: thread ? 'thread' : 'process',
      majorFaults: usage.majorPageFault,
      blockWrites: usage.fsWrite,
      voluntarySwitches: usage.voluntaryContextSwitches,
    };
  } catch {
    return undefined;
  }
}

function resourceDelta(before: ResourceSample, after: ResourceSample, wallMs: number) {
  const threadCpuMs = Math.round(after.cpuMs - before.cpuMs);
  return {
    cpuSampler: after.cpuSampler,
    threadCpuMs,
    offCpuMs: Math.max(0, Math.round(wallMs) - threadCpuMs),
    majorPageFaults: after.majorFaults - before.majorFaults,
    blockWrites: after.blockWrites - before.blockWrites,
    voluntaryContextSwitches: after.voluntarySwitches - before.voluntarySwitches,
  };
}

function resourceTick(
  before: ResourceSample | undefined,
  after: ResourceSample | undefined,
  tickStartMs: number,
  tickEndMs: number
) {
  return {
    resourceScope: 'event_loop_tick' as const,
    tickStartMs,
    tickEndMs,
    ...(before && after
      ? { resources: resourceDelta(before, after, tickEndMs - tickStartMs) }
      : {}),
  };
}

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
    sampleResources?: () => ResourceSample | undefined;
  } = {}
): () => void {
  const now = deps.now ?? (() => performance.now());
  const takeSlowest = deps.takeSlowest ?? takeSlowestQuery;
  const tickMs = deps.tickMs ?? EVENT_LOOP_LAG_TICK_MS;
  takeSlowest();
  const activity = deps.activity ?? new EventLoopActivity(now);
  const deactivate = activity.activate();
  const slowQueries = collectSlowQueryTicks();
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
  const sampleResources = deps.sampleResources ?? sampleProcessResources;
  let beforeHeap = heap();
  let beforeResources = sampleResources();
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
    const afterResources = sampleResources();
    const tick = resourceTick(beforeResources, afterResources, last, at);
    slowQueries.flush(tick);
    if (line) {
      warn(line);
      const report = {
        lagMs,
        ...(samplingProfile ? { samplingProfile } : {}),
        ...tick,
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
    beforeResources = afterResources;
    if (afterHeap !== undefined) {
      beforeHeap = afterHeap;
      heapAt = at;
    }
    last = at;
  }, tickMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    slowQueries.flush(resourceTick(beforeResources, sampleResources(), last, now()));
    slowQueries.stop();
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
