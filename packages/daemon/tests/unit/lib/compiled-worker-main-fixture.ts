import { Worker } from 'node:worker_threads';
import { runtimeWorkerUrl } from '../../../src/lib/runtime-worker-url.ts';

const worker = new Worker(
  runtimeWorkerUrl(
    './compiled-worker-thread-fixture.ts',
    './daemon/tests/unit/lib/compiled-worker-thread-fixture.ts',
    import.meta.url
  )
);
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
