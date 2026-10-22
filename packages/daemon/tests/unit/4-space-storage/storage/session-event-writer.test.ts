import { expect, test } from 'bun:test';
import {
  SessionEventWriter,
  type SessionEventWriteRequest,
  type SessionEventWriteReply,
} from '../../../../src/lib/external-events/session-event-writer';
import type { IngestExternalEventOutcome } from '../../../../src/lib/external-events/ingest-external-event-pipeline';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';

class TestWorker {
  onmessage: ((event: MessageEvent<SessionEventWriteReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: SessionEventWriteRequest[] = [];
  stopped = false;
  constructor(ready = true) {
    if (ready) queueMicrotask(() => this.announceReady());
  }
  announceReady() {
    this.onmessage?.({ data: { ready: true } } as unknown as MessageEvent<SessionEventWriteReply>);
  }
  postMessage(request: SessionEventWriteRequest) {
    this.requests.push(request);
    if (!request.event) queueMicrotask(() => this.reply(request));
  }
  terminate() {
    this.stopped = true;
  }
  reply(request: SessionEventWriteRequest, outcome?: IngestExternalEventOutcome) {
    this.onmessage?.({
      data: {
        id: request.id,
        epoch: request.epoch,
        outcome,
        workerMs: 0,
        queueMs: 0,
        finishedAt: Date.now(),
      },
    } as MessageEvent<SessionEventWriteReply>);
  }
  crash() {
    this.onerror?.({ message: 'synthetic writer failure', preventDefault() {} } as ErrorEvent);
  }
}
const event: ExternalEvent = {
  id: 'event-1',
  spaceId: 'sessions',
  source: 'github',
  topic: 'github/synthetic/repo/pull_request/1',
  dedupeKey: 'once',
  occurredAt: 1,
  ingestedAt: 2,
  summary: 'Complete',
  payload: { body: 'complete result 🦊\n'.repeat(1000) },
};
const outcome: IngestExternalEventOutcome = {
  action: 'ingested',
  eventId: event.id,
  urgency: 'queued',
  render: 'complete',
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fixture = (timeout = 1000) => {
  const workers: TestWorker[] = [];
  const writer = new SessionEventWriter(
    '/synthetic.db',
    () => {
      const w = new TestWorker();
      workers.push(w);
      return w as unknown as Worker;
    },
    timeout
  );
  return { writer, workers };
};

test('serial commands retain complete payload and accepted writes drain before close', async () => {
  const { writer, workers } = fixture();
  const first = writer.ingest(event),
    second = writer.ingest({ ...event, id: 'event-2' });
  await tick();
  expect(workers[0].requests).toHaveLength(1);
  expect(workers[0].requests[0].event).toEqual(event);
  const closing = writer.close();
  await expect(writer.ingest(event)).rejects.toThrow('closed');
  workers[0].reply(workers[0].requests[0], outcome);
  expect(await first).toEqual(outcome);
  await tick();
  workers[0].reply(workers[0].requests[1], {
    action: 'duplicate',
    eventId: event.id,
    terminal: true,
  });
  expect(await second).toMatchObject({ action: 'duplicate', eventId: event.id });
  await closing;
  expect(workers[0].stopped).toBe(true);
  expect(workers).toHaveLength(1);
});

test('a lost active reply is unknown, never replayed, and queued commands fail before dispatch', async () => {
  const { writer, workers } = fixture();
  const failed = Promise.allSettled([
    writer.ingest(event),
    writer.ingest({ ...event, id: 'queued' }),
  ]);
  await tick();
  workers[0].crash();
  const results = await failed;
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(String((results[0] as PromiseRejectedResult).reason)).toContain('outcome unknown');
  expect(workers[0].requests).toHaveLength(1);
  const next = writer.ingest(event);
  await tick();
  workers[1].reply(workers[1].requests[0], outcome);
  expect(await next).toEqual(outcome);
  await writer.close();
});

test('deadline and bounded admission reject explicitly without a synchronous write fallback', async () => {
  const { writer, workers } = fixture(5);
  const accepted = Promise.allSettled(Array.from({ length: 16 }, () => writer.ingest(event)));
  await expect(writer.ingest(event)).rejects.toThrow('queue full');
  const results = await accepted;
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(String((results[0] as PromiseRejectedResult).reason)).toContain('outcome unknown');
  expect(workers[0].requests).toHaveLength(1);
  await writer.close();
});

test('an idle worker failure cannot be reused by the next command', async () => {
  const { writer, workers } = fixture();
  const first = writer.ingest(event);
  await tick();
  workers[0].reply(workers[0].requests[0], outcome);
  await first;
  workers[0].crash();
  const next = writer.ingest(event);
  await tick();
  expect(workers).toHaveLength(2);
  workers[1].reply(workers[1].requests[0], outcome);
  expect(await next).toEqual(outcome);
  await writer.close();
});

test('no write is dispatched before native worker startup completes', async () => {
  const worker = new TestWorker(false);
  const writer = new SessionEventWriter('/synthetic.db', () => worker as unknown as Worker);
  const result = writer.ingest(event);
  await tick();
  expect(worker.requests).toHaveLength(0);
  worker.announceReady();
  worker.announceReady();
  await tick();
  expect(worker.requests).toHaveLength(1);
  worker.reply(worker.requests[0], outcome);
  expect(await result).toEqual(outcome);
  await writer.close();
});

test('startup deadline fails before dispatch instead of reporting an uncertain write', async () => {
  const worker = new TestWorker(false);
  const writer = new SessionEventWriter('/synthetic.db', () => worker as unknown as Worker, 5);
  const error = await writer.ingest(event).catch((error) => String(error));
  expect(error).toBe('Error: Session event writer timeout');
  expect(worker.requests).toHaveLength(0);
  expect(worker.stopped).toBe(true);
  await writer.close();
});
