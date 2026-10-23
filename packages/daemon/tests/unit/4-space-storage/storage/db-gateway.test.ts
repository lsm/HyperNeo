import { describe, expect, test } from 'bun:test';
import {
  DbGateway,
  type DbGatewayReply,
  type DbGatewayRequest,
} from '../../../../src/storage/db-gateway/db-gateway';
import { defineDbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { recordWouldRefuse } from '../../../../src/storage/repositories/device-pairing-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

class TestWorker {
  onmessage: ((event: MessageEvent<DbGatewayReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: DbGatewayRequest[] = [];
  stopped = false;
  constructor(ready = true) {
    if (ready) queueMicrotask(() => this.emit({ ready: true }));
  }
  postMessage(request: DbGatewayRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.stopped = true;
  }
  emit(data: DbGatewayReply) {
    this.onmessage?.({ data } as MessageEvent<DbGatewayReply>);
  }
  crash() {
    this.onerror?.({ message: 'synthetic worker failure', preventDefault() {} } as ErrorEvent);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const seen = { reason: 'host_not_allowed', kind: 'ws', host: 'mac.ts.net', origin: null };
const countRows = defineDbOp({
  name: 'test.countRows',
  mode: 'read',
  run: (db: Database) =>
    (db.prepare('SELECT COUNT(*) AS n FROM would_refuse_requests').get() as { n: number }).n,
});

function fixture() {
  const workers: TestWorker[] = [];
  const gateway = new DbGateway('/synthetic.db', null, undefined, () => {
    const worker = new TestWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { gateway, workers };
}

describe('DbGateway', () => {
  test('sends reads and writes to their own worker and resolves each reply by id', async () => {
    const { gateway, workers } = fixture();
    const write = gateway.run(recordWouldRefuse, { seen, now: 5 });
    const read = gateway.run(countRows, undefined);
    await tick();
    const [reader, writer] = [
      workers.find((w) => w.requests[0]?.lane === 'read')!,
      workers.find((w) => w.requests[0]?.lane === 'write')!,
    ];
    expect(workers).toHaveLength(2);
    expect(writer.requests).toEqual([
      expect.objectContaining({ op: 'pairing.recordWouldRefuse', args: { seen, now: 5 } }),
    ]);
    reader.emit({ id: reader.requests[0].id, result: 3 });
    writer.emit({ id: writer.requests[0].id, error: 'database is locked' });
    expect(await read).toBe(3);
    await expect(write).rejects.toThrow('database is locked');
  });

  test('a crashed worker rejects what it held and the next call starts a new one', async () => {
    const { gateway, workers } = fixture();
    const held = gateway.run(recordWouldRefuse, { seen, now: 5 });
    await tick();
    workers[0].crash();
    await expect(held).rejects.toThrow('synthetic worker failure');
    expect(workers[0].stopped).toBe(true);
    const next = gateway.run(recordWouldRefuse, { seen, now: 6 });
    await tick();
    expect(workers).toHaveLength(2);
    workers[1].emit({ id: workers[1].requests[0].id, result: null });
    expect(await next).toBeNull();
  });

  test('waits for the worker to be ready before sending', async () => {
    const worker = new TestWorker(false);
    const gateway = new DbGateway('/synthetic.db', null, undefined, () => worker as never);
    const pending = gateway.run(recordWouldRefuse, { seen, now: 5 });
    await tick();
    expect(worker.requests).toEqual([]);
    worker.emit({ ready: true });
    await tick();
    worker.emit({ id: worker.requests[0].id, result: null });
    expect(await pending).toBeNull();
  });

  test('close asks each started worker to close its connection, then stops it', async () => {
    const { gateway, workers } = fixture();
    const write = gateway.run(recordWouldRefuse, { seen, now: 5 });
    await tick();
    workers[0].emit({ id: workers[0].requests[0].id, result: null });
    await write;
    const closing = gateway.close();
    await tick();
    expect(workers[0].requests.at(-1)?.op).toBeNull();
    workers[0].emit({ id: workers[0].requests.at(-1)!.id, result: null });
    await closing;
    expect(workers[0].stopped).toBe(true);
    expect(workers).toHaveLength(1);
  });

  test('an in-memory database runs each op inline in a transaction', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE would_refuse_requests (reason TEXT, kind TEXT, host TEXT, origin TEXT,
      count INTEGER NOT NULL DEFAULT 1, first_seen_at INTEGER, last_seen_at INTEGER)`);
    const gateway = new DbGateway(':memory:', db);
    await gateway.run(recordWouldRefuse, { seen, now: 5 });
    await gateway.run(recordWouldRefuse, { seen, now: 6 });
    expect(await gateway.run(countRows, undefined)).toBe(1);
    db.close();
  });

  test('the worker registry holds every op the daemon sends through the gateway', () => {
    expect(DB_OPS.get(recordWouldRefuse.name)).toBe(recordWouldRefuse);
  });
});
