import { startEventLoopWatchdog } from '../../../src/lib/event-loop-watchdog';

const watchdog = await startEventLoopWatchdog({
  stallMs: 250,
  heartbeatMs: 25,
  ...(process.env.WATCHDOG_MARKER_PATH ? { markerPath: process.env.WATCHDOG_MARKER_PATH } : {}),
});
if (!watchdog) {
  process.stderr.write('fixture: watchdog failed to start\n');
  process.exit(3);
}
process.stderr.write('fixture: blocking briefly\n');
const deadline = Date.now() + 1200;
while (Date.now() < deadline) {}
process.stderr.write('fixture: released\n');
setInterval(() => {}, 1000);
