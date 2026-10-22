import { expect, test } from 'bun:test';
import {
  SDKStatusReader,
  type SDKStatusReply,
  type SDKStatusRequest,
} from '../../../../src/storage/sdk-status-reader';

class TestWorker {
  onmessage: ((event: MessageEvent<SDKStatusReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: SDKStatusRequest[] = [];
  stopped = false;
  postMessage(request: SDKStatusRequest) {
    this.requests.push(request);
    if (!request.args) queueMicrotask(() => this.reply(request, null));
  }
  terminate() {
    this.stopped = true;
  }
  reply(request: SDKStatusRequest, result: typeof page | null) {
    this.onmessage?.({
      data: {
        id: request.id,
        epoch: request.epoch,
        result,
        finishedAt: Date.now(),
        workerMs: 0,
        queueMs: 0,
      },
    } as MessageEvent<SDKStatusReply>);
  }
  crash() {
    this.onerror?.({ message: 'synthetic failure', preventDefault() {} } as ErrorEvent);
  }
}
const args = { sessionId: 'synthetic-session', status: 'consumed' as const, limit: 20 };
const page = {
  messages: [
    {
      dbId: 'db-1',
      uuid: 'm-1',
      timestamp: 1,
      status: 'consumed' as const,
      text: 'Complete text 🦊\n',
    },
  ],
  total: 31,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(timeoutMs = 1000) {
  const workers: TestWorker[] = [];
  const reader = new SDKStatusReader(
    '/synthetic.db',
    () => {
      const worker = new TestWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    timeoutMs
  );
  return { reader, workers };
}

test('serial status pages retain complete output and drain before close', async () => {
  const { reader, workers } = fixture();
  const first = reader.read(args),
    second = reader.read(args);
  await tick();
  const worker = workers[0];
  worker.reply(worker.requests[0], page);
  expect(await first).toEqual(page);
  await tick();
  worker.reply(worker.requests[1], page);
  expect(await second).toEqual(page);
  const closed = reader.close();
  await expect(reader.read(args)).rejects.toThrow('closed');
  await closed;
  expect(workers).toHaveLength(1);
  expect(worker.stopped).toBe(true);
});

test('worker crash rejects accepted reads; only a new request can open a replacement', async () => {
  const { reader, workers } = fixture();
  const results = Promise.allSettled([reader.read(args), reader.read(args)]);
  await tick();
  workers[0].crash();
  expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected']);
  const later = reader.read(args);
  await tick();
  workers[0].crash();
  workers[1].reply(workers[1].requests[0], page);
  expect(await later).toEqual(page);
  await reader.close();
});

test('stale response IDs cannot answer the current status request', async () => {
  const { reader, workers } = fixture();
  let answered = false;
  const result = reader.read(args).then((value) => {
    answered = true;
    return value;
  });
  await tick();
  const request = workers[0].requests[0];
  workers[0].reply({ ...request, epoch: request.epoch - 1 }, page);
  await tick();
  expect(answered).toBe(false);
  workers[0].reply(request, page);
  expect(await result).toEqual(page);
  await reader.close();
});

test('timeout rejects without a synchronous fallback and releases queued reads', async () => {
  const { reader } = fixture(5);
  const results = await Promise.allSettled([reader.read(args), reader.read(args)]);
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  await reader.close();
});

test('backpressure refuses excess requests instead of accumulating unbounded work', async () => {
  const { reader, workers } = fixture();
  const accepted = Promise.allSettled(Array.from({ length: 16 }, () => reader.read(args)));
  await expect(reader.read(args)).rejects.toThrow('queue full');
  await tick();
  workers[0].crash();
  expect((await accepted).every((r) => r.status === 'rejected')).toBe(true);
  await reader.close();
});
