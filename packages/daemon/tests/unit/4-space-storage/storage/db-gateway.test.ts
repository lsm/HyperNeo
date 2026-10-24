import { describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '../../../../src/lib/logger';
import {
  bindGateway,
  bindSpaceTaskLane,
  DbGateway,
  gatewayFor,
  spaceTaskLaneFor,
  type DbGatewayReply,
  type DbGatewayRequest,
} from '../../../../src/storage/db-gateway/db-gateway';
import { defineDbOp, defineRepositoryOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { recordWouldRefuse } from '../../../../src/storage/repositories/device-pairing-repository';
import { recordOperationRefusal } from '../../../../src/storage/repositories/operation-refusal-repository';
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

  test('a worker that cannot start rejects the call, and the next call tries again', async () => {
    let starts = 0;
    const gateway = new DbGateway('/synthetic.db', null, undefined, () => {
      starts += 1;
      if (starts === 1) throw new Error('no worker support');
      const worker = new TestWorker();
      queueMicrotask(() => queueMicrotask(() => worker.emit({ id: 2, result: null })));
      return worker as unknown as Worker;
    });
    await expect(gateway.run(recordWouldRefuse, { seen, now: 5 })).rejects.toThrow(
      'no worker support'
    );
    expect(await gateway.run(recordWouldRefuse, { seen, now: 6 })).toBeNull();
    expect(starts).toBe(2);
  });

  test('a lane holding 1024 calls refuses the next one instead of queueing it', async () => {
    const { gateway, workers } = fixture();
    const held = Array.from({ length: 1024 }, (_, now) =>
      gateway.run(recordWouldRefuse, { seen, now })
    );
    await expect(gateway.run(recordWouldRefuse, { seen, now: 2000 })).rejects.toThrow(
      'DB gateway write queue full'
    );
    await tick();
    for (const request of workers[0].requests) workers[0].emit({ id: request.id, result: null });
    await Promise.all(held);
    void gateway.run(recordWouldRefuse, { seen, now: 3000 });
    await tick();
    expect(workers[0].requests).toHaveLength(1025);
    expect(workers[0].requests.at(-1)?.args).toEqual({ seen, now: 3000 });
  });

  test('a busy worker that keeps replying is never recycled, however long the queue', async () => {
    const workers: TestWorker[] = [];
    const gateway = new DbGateway(
      '/synthetic.db',
      null,
      undefined,
      () => {
        const worker = new TestWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      40
    );
    const calls = [1, 2, 3, 4].map((now) => gateway.run(recordWouldRefuse, { seen, now }));
    await tick();
    for (const request of workers[0].requests) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      workers[0].emit({ id: request.id, result: null });
    }
    expect(await Promise.all(calls)).toEqual([null, null, null, null]);
    expect(workers[0].stopped).toBe(false);
    expect(workers).toHaveLength(1);
  });

  test('a call with no reply in time fails as unknown and recycles the worker', async () => {
    const workers: TestWorker[] = [];
    const gateway = new DbGateway(
      '/synthetic.db',
      null,
      undefined,
      () => {
        const worker = new TestWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      20
    );
    const lost = gateway.run(recordWouldRefuse, { seen, now: 5 });
    await expect(lost).rejects.toThrow('gave no reply for 20 ms; outcome unknown');
    expect(workers[0].stopped).toBe(true);
    const next = gateway.run(recordWouldRefuse, { seen, now: 6 });
    await tick();
    workers[1].emit({ id: workers[1].requests[0].id, result: null });
    expect(await next).toBeNull();
  });

  test('a request the worker cannot receive fails without stalling the lane', async () => {
    const { gateway, workers } = fixture();
    const first = gateway.run(recordWouldRefuse, { seen, now: 5 });
    await tick();
    workers[0].postMessage = () => {
      throw new Error('could not be cloned');
    };
    await expect(gateway.run(recordWouldRefuse, { seen, now: () => 6 } as never)).rejects.toThrow(
      'could not be cloned'
    );
    workers[0].emit({ id: workers[0].requests[0].id, result: null });
    expect(await first).toBeNull();
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

  test('close asks each started worker to close its connection, stops it, and refuses later calls', async () => {
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
    await expect(gateway.run(recordWouldRefuse, { seen, now: 6 })).rejects.toThrow(
      'DB gateway write closed'
    );
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

  test('a repository op runs only the methods it lists, on a repository over the connection', async () => {
    class Counter {
      constructor(private readonly db: Database) {}
      count() {
        return (
          this.db.prepare('SELECT COUNT(*) AS n FROM would_refuse_requests').get() as { n: number }
        ).n;
      }
      wipe() {
        this.db.prepare('DELETE FROM would_refuse_requests').run();
      }
    }
    const db = new Database(':memory:');
    db.exec('CREATE TABLE would_refuse_requests (reason TEXT)');
    db.exec("INSERT INTO would_refuse_requests VALUES ('a'), ('b')");
    const counts = defineRepositoryOp('test.counter', 'read', Counter, ['count']);
    const gateway = new DbGateway(':memory:', db);
    expect(await gateway.call(counts, 'count')).toBe(2);
    await expect(gateway.run(counts, { method: 'wipe', args: [] })).rejects.toThrow(
      'test.counter does not run wipe'
    );
    expect(await gateway.call(counts, 'count')).toBe(2);
    db.close();
  });

  test('table changes an op records replay on the main thread before its caller resumes', async () => {
    const touch = defineDbOp({
      name: 'test.touch',
      mode: 'write',
      run: (_db: Database, table: string, changes) => {
        changes.notifyChange(table, { sessionId: 's1' });
        return table;
      },
    });
    const replayed: unknown[] = [];
    const db = new Database(':memory:');
    const inline = new DbGateway(':memory:', db);
    inline.onChanges = (changes) => replayed.push(...changes);
    expect(await inline.run(touch, 'sessions')).toBe('sessions');
    expect(replayed).toEqual([{ table: 'sessions', scope: { sessionId: 's1' } }]);

    const { gateway, workers } = fixture();
    gateway.onChanges = (changes) => replayed.push(...changes);
    const pending = gateway.run(touch, 'tasks').then(() => replayed.length);
    await tick();
    workers[0].emit({
      id: workers[0].requests[0].id,
      result: 'tasks',
      changes: [{ table: 'tasks' }],
    });
    expect(await pending).toBe(2);
    workers[0].emit({ id: 99, error: 'late', changes: [{ table: 'ignored' }] } as DbGatewayReply);
    expect(replayed.at(-1)).toEqual({ table: 'tasks' });
    db.close();
  });

  test('a listener that throws during replay never strands the committed write', async () => {
    const error = spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const touch = defineDbOp({
      name: 'test.touch',
      mode: 'write',
      run: (_db: Database, _args: undefined, changes) => {
        changes.notifyChange('sessions');
        return 'done';
      },
    });
    const { gateway, workers } = fixture();
    gateway.onChanges = () => {
      throw new Error('listener failed');
    };
    const pending = gateway.run(touch, undefined);
    await tick();
    workers[0].emit({
      id: workers[0].requests[0].id,
      result: 'done',
      changes: [{ table: 'sessions' }],
    });
    expect(await pending).toBe('done');
    const db = new Database(':memory:');
    const inline = new DbGateway(':memory:', db);
    inline.onChanges = () => {
      throw new Error('listener failed');
    };
    expect(await inline.run(touch, undefined)).toBe('done');
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
    db.close();
  });

  test('an unbound connection warns once that its recorded changes went unannounced', async () => {
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const touch = defineDbOp({
      name: 'test.touch',
      mode: 'write',
      run: (_db: Database, table: string, changes) => changes.notifyChange(table),
    });
    const db = new Database(':memory:');
    await gatewayFor(db).run(touch, 'sessions');
    await gatewayFor(db).run(touch, 'tasks');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('sessions');
    warn.mockRestore();
    db.close();
  });

  test('gatewayFor returns the gateway bound to a connection, or an inline one', async () => {
    const db = new Database(':memory:');
    const unbound = gatewayFor(db);
    expect(gatewayFor(db)).toBe(unbound);
    const bound = new DbGateway(':memory:', db);
    bindGateway(db, bound);
    expect(gatewayFor(db)).toBe(bound);
    expect(gatewayFor(new Database(':memory:'))).not.toBe(bound);
    db.close();
  });

  test('the worker registry holds every op the daemon sends through the gateway', () => {
    expect(DB_OPS.get(recordWouldRefuse.name)).toBe(recordWouldRefuse);
    expect(DB_OPS.get(recordOperationRefusal.name)).toBe(recordOperationRefusal);
  });

  test('an operation refusal is recorded through the gateway', async () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE operation_refusals (id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL, reason TEXT NOT NULL, session_id TEXT, at INTEGER NOT NULL)`);
    const gateway = new DbGateway(':memory:', db);
    await gateway.run(recordOperationRefusal, {
      refusal: { operation: 'task.create', reason: 'not_allowed' },
      sessionId: 'session-1',
      at: 7,
    });
    expect(
      db
        .prepare('SELECT operation, reason, session_id AS sessionId, at FROM operation_refusals')
        .all()
    ).toEqual([{ operation: 'task.create', reason: 'not_allowed', sessionId: 'session-1', at: 7 }]);
    db.close();
  });
});

describe('spaceTaskLaneFor', () => {
  const touch = defineDbOp<undefined, void>({
    name: 'test.touchSpaceTasks',
    mode: 'write',
    run: (_db, _args, changes) => changes.notifyChange('space_tasks', { taskId: 'task-1' }),
  });

  test('runs on the lane the facade bound to the connection', async () => {
    const db = new Database(':memory:');
    const lane = new DbGateway(':memory:', db);
    const replayed: string[] = [];
    lane.onChanges = (changes) => replayed.push(...changes.map((change) => change.table));
    bindSpaceTaskLane(db, lane);
    const fallback: string[] = [];

    await spaceTaskLaneFor(db, { notifyChange: (table) => fallback.push(table) }).run(
      touch,
      undefined
    );

    expect(replayed).toEqual(['space_tasks']);
    expect(fallback).toEqual([]);
    db.close();
  });

  test('replays into the caller changes when no lane is bound', async () => {
    const db = new Database(':memory:');
    const notified: unknown[] = [];

    await spaceTaskLaneFor(db, {
      notifyChange: (table, scope) => notified.push({ table, scope }),
    }).run(touch, undefined);

    expect(notified).toEqual([{ table: 'space_tasks', scope: { taskId: 'task-1' } }]);
    db.close();
  });
});
