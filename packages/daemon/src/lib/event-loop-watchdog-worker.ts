import { writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

interface EventLoopWatchdogWorkerData {
  deferStallDetection: boolean;
  pid: number;
  stallMs: number;
  checkIntervalMs: number;
  killMode: 'sigkill' | 'observe';
}

type WatchdogCommand =
  | { type: 'heartbeat' }
  | { type: 'arm-stall-detection' }
  | { type: 'arm-shutdown-fuse'; timeoutMs: number };

type WatchdogNotice =
  | { type: 'stall-detected'; stalledForMs: number }
  | { type: 'fuse-expired'; overdueMs: number };

const { pid, stallMs, checkIntervalMs, killMode, deferStallDetection } =
  workerData as EventLoopWatchdogWorkerData;

const SUSPENSION_GAP_MS = Math.max(checkIntervalMs * 4, 1000);

let stallDetectionArmed = !deferStallDetection;
let lastHeartbeatMs = Date.now();
let lastCheckMs = Date.now();
let fuseDeadlineMs: number | null = null;
let acted = false;

parentPort?.on('message', (command: WatchdogCommand) => {
  if (command.type === 'heartbeat') {
    lastHeartbeatMs = Date.now();
  } else if (command.type === 'arm-stall-detection' && !stallDetectionArmed) {
    lastHeartbeatMs = Date.now();
    stallDetectionArmed = true;
  } else if (command.type === 'arm-shutdown-fuse') {
    fuseDeadlineMs = Date.now() + command.timeoutMs;
  }
});

setInterval(() => {
  if (acted) return;
  const now = Date.now();
  const checkGapMs = now - lastCheckMs;
  lastCheckMs = now;
  if (checkGapMs > SUSPENSION_GAP_MS) {
    lastHeartbeatMs = now;
    if (fuseDeadlineMs !== null) {
      fuseDeadlineMs += checkGapMs;
    }
    return;
  }
  const stalledForMs = now - lastHeartbeatMs;
  if (stallDetectionArmed && stalledForMs >= stallMs) {
    acted = true;
    report(`event loop stalled for ${stalledForMs}ms (stall threshold ${stallMs}ms)`, {
      type: 'stall-detected',
      stalledForMs,
    });
  } else if (fuseDeadlineMs !== null && now >= fuseDeadlineMs) {
    acted = true;
    report(`graceful shutdown exceeded its fuse (overdue by ${now - fuseDeadlineMs}ms)`, {
      type: 'fuse-expired',
      overdueMs: now - fuseDeadlineMs,
    });
  }
}, checkIntervalMs);

function report(reason: string, notice: WatchdogNotice): void {
  if (killMode === 'sigkill') {
    writeSync(2, `[EventLoopWatchdog] killing daemon pid=${pid}: ${reason}\n`);
    process.kill(pid, 'SIGKILL');
    return;
  }
  parentPort?.postMessage(notice);
}
