// @ts-expect-error bun embeds this worker source as a file asset, not a module default export
import workerUrl from './event-loop-watchdog-worker.ts' with { type: 'file' };

export const eventLoopWatchdogWorkerAssetUrl: string = workerUrl;
