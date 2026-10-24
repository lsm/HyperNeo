import { runtimeWorkerUrl } from './runtime-worker-url.ts';

export const eventLoopWatchdogWorkerAssetUrl = runtimeWorkerUrl(
  './event-loop-watchdog-worker.ts',
  './daemon/src/lib/event-loop-watchdog-worker.ts',
  import.meta.url
);
