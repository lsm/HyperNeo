import { Worker } from 'node:worker_threads';
import { runtimeWorkerUrl } from '../../../src/lib/runtime-worker-url.ts';

const target = runtimeWorkerUrl(
  './compiled-worker-thread-fixture.ts',
  './daemon/tests/unit/lib/compiled-worker-thread-fixture.ts',
  import.meta.url
);
console.error(JSON.stringify({ moduleUrl: import.meta.url, target: String(target) }));
const worker = new Worker(target);
const timer = setTimeout(() => {
  worker.terminate();
  process.exitCode = 1;
}, 3000);
worker.on('message', (message: string) => {
  clearTimeout(timer);
  console.log(message);
  worker.terminate();
});
worker.on('error', (error: Error) => {
  clearTimeout(timer);
  throw error;
});
