import { startEventLoopWatchdog } from '../../../src/lib/event-loop-watchdog';

const watchdog = await startEventLoopWatchdog({
  stallMs: 800,
  heartbeatMs: 25,
  shutdownFuseMs: 320,
});
if (!watchdog) {
  process.stderr.write('fixture: watchdog failed to start\n');
  process.exit(3);
}
process.stdout.write('fixture: ready\n');
setInterval(() => {}, 1000);
