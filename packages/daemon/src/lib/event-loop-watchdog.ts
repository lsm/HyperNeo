import { Worker } from 'node:worker_threads';
import { Logger } from './logger.ts';

export const EVENT_LOOP_WATCHDOG_HEARTBEAT_MS = 2_000;
export const EVENT_LOOP_WATCHDOG_STALL_MS = 60_000;
export const EVENT_LOOP_WATCHDOG_SHUTDOWN_FUSE_MS = 30_000;
export const EVENT_LOOP_WATCHDOG_MAX_CHECK_INTERVAL_MS = 500;
export const EVENT_LOOP_WATCHDOG_STARTUP_GRACE_MS = 10 * 60_000;

export type StallArmReason = 'startup_settled' | 'grace_expired';

export interface ArmStallDetectionOptions {
  graceMs?: number;
  onArm?: (reason: StallArmReason) => void;
}

export function armStallDetectionWhenStartupSettles(
  handle: EventLoopWatchdogHandle | null,
  startupSettled: PromiseLike<unknown>,
  options: ArmStallDetectionOptions = {}
): void {
  if (!handle) return;
  const graceMs = options.graceMs ?? EVENT_LOOP_WATCHDOG_STARTUP_GRACE_MS;
  let armed = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = (reason: StallArmReason): void => {
    if (armed) return;
    armed = true;
    if (graceTimer) clearTimeout(graceTimer);
    handle.armStallDetection();
    options.onArm?.(reason);
  };
  graceTimer = setTimeout(() => arm('grace_expired'), graceMs);
  graceTimer.unref?.();
  startupSettled.then(
    () => arm('startup_settled'),
    () => arm('startup_settled')
  );
}

export type EventLoopWatchdogNotice =
  | { type: 'stall-detected'; stalledForMs: number }
  | { type: 'fuse-expired'; overdueMs: number };

export interface EventLoopWatchdogOptions {
  deferStallDetection?: boolean;
  stallMs?: number;
  heartbeatMs?: number;
  shutdownFuseMs?: number;
  killMode?: 'sigkill' | 'observe';
  onNotice?: (notice: EventLoopWatchdogNotice) => void;
}

export interface EventLoopWatchdogHandle {
  armStallDetection(): void;
  armShutdownFuse(timeoutMs?: number): void;
  stop(): void;
}

const logger = new Logger('EventLoopWatchdog');

async function resolveWorkerUrl(): Promise<string | URL> {
  if (process.versions?.bun) {
    const { eventLoopWatchdogWorkerAssetUrl } = await import(
      './event-loop-watchdog-worker-asset.ts'
    );
    return eventLoopWatchdogWorkerAssetUrl;
  }
  return new URL('./event-loop-watchdog-worker.ts', import.meta.url);
}

export async function startEventLoopWatchdog(
  options: EventLoopWatchdogOptions = {}
): Promise<EventLoopWatchdogHandle | null> {
  if (process.env.HYPERNEO_DISABLE_EVENT_LOOP_WATCHDOG === '1') {
    return null;
  }
  const stallMs = options.stallMs ?? EVENT_LOOP_WATCHDOG_STALL_MS;
  const heartbeatMs = options.heartbeatMs ?? EVENT_LOOP_WATCHDOG_HEARTBEAT_MS;
  const shutdownFuseMs = options.shutdownFuseMs ?? EVENT_LOOP_WATCHDOG_SHUTDOWN_FUSE_MS;
  const killMode = options.killMode ?? 'sigkill';

  let worker: Worker;
  try {
    const checkIntervalMs = Math.min(
      Math.max(20, Math.floor(Math.min(stallMs, shutdownFuseMs) / 4)),
      EVENT_LOOP_WATCHDOG_MAX_CHECK_INTERVAL_MS
    );
    worker = new Worker(await resolveWorkerUrl(), {
      workerData: {
        pid: process.pid,
        stallMs,
        checkIntervalMs,
        killMode,
        deferStallDetection: options.deferStallDetection ?? false,
      },
    });
  } catch (error) {
    logger.warn(
      `failed to start; daemon runs without an event-loop watchdog: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
  worker.unref?.();
  worker.on('message', (notice: EventLoopWatchdogNotice) => {
    options.onNotice?.(notice);
  });

  let stopped = false;
  const heartbeatTimer = setInterval(() => {
    worker.postMessage({ type: 'heartbeat' });
  }, heartbeatMs);
  heartbeatTimer.unref?.();
  worker.postMessage({ type: 'heartbeat' });
  worker.on('error', (error) => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    logger.warn(
      `worker failed; daemon runs without an event-loop watchdog: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });

  return {
    armStallDetection() {
      if (stopped) return;
      worker.postMessage({ type: 'arm-stall-detection' });
    },
    armShutdownFuse(timeoutMs: number = shutdownFuseMs) {
      if (stopped) return;
      worker.postMessage({ type: 'arm-shutdown-fuse', timeoutMs });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      worker.terminate();
    },
  };
}
