import { startEventLoopWatchdog } from '../../../src/lib/event-loop-watchdog';

const watchdog = await startEventLoopWatchdog({ stallMs: 250, heartbeatMs: 25 });
if (!watchdog) {
  process.stderr.write('fixture: watchdog failed to start\n');
  process.exit(3);
}
process.stderr.write('fixture: spinning forever\n');
for (;;) {}
