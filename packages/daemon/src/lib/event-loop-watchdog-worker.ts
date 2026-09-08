import { parentPort, workerData } from 'node:worker_threads';

interface EventLoopWatchdogWorkerData {
  pid: number;
  stallMs: number;
  checkIntervalMs: number;
  killMode: 'sigkill' | 'observe';
}

type WatchdogCommand = { type: 'heartbeat' } | { type: 'arm-shutdown-fuse'; timeoutMs: number };

type WatchdogNotice =
  | { type: 'stall-detected'; stalledForMs: number }
  | { type: 'fuse-expired'; overdueMs: number };

const { pid, stallMs, checkIntervalMs, killMode } = workerData as EventLoopWatchdogWorkerData;

let lastHeartbeatMs = Date.now();
let fuseDeadlineMs: number | null = null;
let acted = false;

parentPort?.on('message', (command: WatchdogCommand) => {
  if (command.type === 'heartbeat') {
    lastHeartbeatMs = Date.now();
  } else if (command.type === 'arm-shutdown-fuse') {
    fuseDeadlineMs = Date.now() + command.timeoutMs;
  }
});

setInterval(() => {
  if (acted) return;
  const now = Date.now();
  const stalledForMs = now - lastHeartbeatMs;
  if (stalledForMs >= stallMs) {
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
    process.stderr.write(`[EventLoopWatchdog] killing daemon pid=${pid}: ${reason}\n`);
    process.kill(pid, 'SIGKILL');
    return;
  }
  parentPort?.postMessage(notice);
}
