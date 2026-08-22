import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { DbQueryWorkerService } from '../../../../src/lib/db-query/db-query-worker-service';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

type PostedMessage = {
  id: string;
  dbPath?: string;
  scopeType?: string;
  scopeValue?: string;
  sql?: string;
  params?: unknown[];
  limit?: number;
  error?: string;
  result?: { rows: Record<string, unknown>[]; rowCount: number; truncated: boolean };
};

class FakeWorker {
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onPosted: ((message: PostedMessage) => void) | null = null;
  readonly posted: PostedMessage[] = [];
  terminated = false;

  postMessage(message: Record<string, unknown>): void {
    const posted = message as PostedMessage;
    this.posted.push(posted);
    this.onPosted?.(posted);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(message: Record<string, unknown>): void {
    this.onmessage?.({ data: message });
  }

  crash(): void {
    this.onerror?.(new Error('worker crashed'));
  }
}

function asWorker(fake: FakeWorker): Worker {
  return fake as unknown as Worker;
}

const sampleResult = {
  rows: [{ id: 'room-1' }],
  rowCount: 1,
  truncated: false,
};

describe('DbQueryWorkerService', () => {
  test('resolves worker results for a query', async () => {
    const fake = new FakeWorker();
    const service = new DbQueryWorkerService('/tmp/hyperneo.db', 1_000, () => asWorker(fake));

    const pending = service.query({
      scopeType: 'space',
      scopeValue: 'space-1',
      sql: 'SELECT * FROM space_tasks',
      params: [],
      limit: 50,
    });

    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0].dbPath).toBe('/tmp/hyperneo.db');
    expect(fake.posted[0].scopeType).toBe('space');
    expect(fake.posted[0].scopeValue).toBe('space-1');
    expect(fake.posted[0].sql).toBe('SELECT * FROM space_tasks');
    expect(fake.posted[0].limit).toBe(50);

    fake.respond({ id: fake.posted[0].id, result: sampleResult });
    await expect(pending).resolves.toEqual(sampleResult);
    expect(fake.terminated).toBe(false);
  });

  test('routes concurrent queries by request id on the shared worker', async () => {
    const fake = new FakeWorker();
    const service = new DbQueryWorkerService('/tmp/hyperneo.db', 1_000, () => asWorker(fake));

    const first = service.query({
      scopeType: 'global',
      scopeValue: '',
      sql: 'SELECT * FROM rooms',
    });
    const second = service.query({
      scopeType: 'global',
      scopeValue: '',
      sql: 'SELECT * FROM spaces',
    });

    expect(fake.posted).toHaveLength(2);
    const [firstMessage, secondMessage] = fake.posted;

    fake.respond({ id: secondMessage.id, result: sampleResult });
    await expect(second).resolves.toEqual(sampleResult);

    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstSettled).toBe(false);

    fake.respond({
      id: firstMessage.id,
      result: { rows: [], rowCount: 0, truncated: false },
    });
    await expect(first).resolves.toEqual({ rows: [], rowCount: 0, truncated: false });
  });

  test('rejects with the worker error message', async () => {
    const fake = new FakeWorker();
    const service = new DbQueryWorkerService('/tmp/hyperneo.db', 1_000, () => asWorker(fake));

    const pending = service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 1' });
    fake.respond({ id: fake.posted[0].id, error: 'Query execution error: no such column: x' });

    await expect(pending).rejects.toThrow('Query execution error: no such column: x');
  });

  test('terminates the worker and rejects with a timeout error', async () => {
    const fake = new FakeWorker();
    const service = new DbQueryWorkerService('/tmp/hyperneo.db', 20, () => asWorker(fake));

    const pending = service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 1' });
    await expect(pending).rejects.toThrow('Query timed out');
    expect(fake.terminated).toBe(true);
    expect(fake.posted).toHaveLength(1);
  });

  test('fails queries queued behind a timed-out query', async () => {
    const fake = new FakeWorker();
    const service = new DbQueryWorkerService('/tmp/hyperneo.db', 20, () => asWorker(fake));

    const slow = expect(
      service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 1' })
    ).rejects.toThrow('Query timed out');
    const queued = expect(
      service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 2' })
    ).rejects.toThrow('Query timed out');

    await slow;
    await queued;
    expect(fake.terminated).toBe(true);
  });

  test('respawns the worker for the next call after a timeout', async () => {
    const first = new FakeWorker();
    let current = first;
    const service = new DbQueryWorkerService('/tmp/hyperneo.db', 20, () => asWorker(current));

    const timedOut = service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 1' });
    await expect(timedOut).rejects.toThrow('Query timed out');
    expect(first.terminated).toBe(true);

    current = new FakeWorker();
    const retry = service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 2' });
    expect(current.posted).toHaveLength(1);
    current.respond({ id: current.posted[0].id, result: sampleResult });
    await expect(retry).resolves.toEqual(sampleResult);
  });

  test('rejects all queries when the worker errors', async () => {
    const fake = new FakeWorker();
    const service = new DbQueryWorkerService('/tmp/hyperneo.db', 1_000, () => asWorker(fake));

    const first = service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 1' });
    const second = service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 2' });
    fake.crash();

    await expect(first).rejects.toThrow('db_query worker failed');
    await expect(second).rejects.toThrow('db_query worker failed');
    expect(fake.terminated).toBe(true);
  });

  test('close cancels in-flight queries and rejects later ones', async () => {
    const fake = new FakeWorker();
    const service = new DbQueryWorkerService('/tmp/hyperneo.db', 1_000, () => asWorker(fake));

    const pending = service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 1' });
    service.close();

    await expect(pending).rejects.toThrow('Query cancelled');
    expect(fake.terminated).toBe(true);
    await expect(
      service.query({ scopeType: 'global', scopeValue: '', sql: 'SELECT 2' })
    ).rejects.toThrow('Query cancelled');
  });
});

describe.skipIf(!isBun)('DbQueryWorkerService real worker', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createQueryDb(): string {
    const dir = join(
      tmpdir(),
      `db-query-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    const path = join(dir, 'test.db');
    const db = new BunDatabase(path);
    db.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT, config TEXT)');
    db.exec(
      'CREATE TABLE tasks (id TEXT PRIMARY KEY, room_id TEXT, title TEXT, created_at INTEGER)'
    );
    db.exec("INSERT INTO rooms VALUES ('room-1', 'Room 1', '{\"m\":\"o\"}')");
    db.exec("INSERT INTO rooms VALUES ('room-2', 'Room 2', NULL)");
    db.exec("INSERT INTO tasks VALUES ('task-1', 'room-1', 'Task 1', 1000)");
    db.exec("INSERT INTO tasks VALUES ('task-2', 'room-1', 'Task 2', 2000)");
    db.exec("INSERT INTO tasks VALUES ('task-3', 'room-2', 'Task 3', 3000)");
    db.close();
    return path;
  }

  test('runs a scoped query on the worker connection', async () => {
    const service = new DbQueryWorkerService(createQueryDb(), 5_000);

    const globalResult = await service.query({
      scopeType: 'global',
      scopeValue: '',
      sql: 'SELECT * FROM rooms',
    });
    expect(globalResult.rowCount).toBe(2);
    expect(globalResult.rows.every((row) => !('config' in row))).toBe(true);

    const scopedResult = await service.query({
      scopeType: 'room',
      scopeValue: 'room-1',
      sql: 'SELECT * FROM tasks',
    });
    expect(scopedResult.rowCount).toBe(2);
    expect(scopedResult.rows.every((row) => row.room_id === 'room-1')).toBe(true);

    service.close();
  });

  test('rejects invalid SQL with the validator error', async () => {
    const service = new DbQueryWorkerService(createQueryDb(), 5_000);

    await expect(
      service.query({ scopeType: 'global', scopeValue: '', sql: 'DELETE FROM rooms' })
    ).rejects.toThrow('Only SELECT');

    service.close();
  });

  test('terminates a slow query at the timeout while the main thread stays responsive', async () => {
    const service = new DbQueryWorkerService(createQueryDb(), 200);

    const slowQuery = service.query({
      scopeType: 'global',
      scopeValue: '',
      sql: 'WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM cnt WHERE n < 200000000) SELECT COUNT(*) AS total FROM cnt',
    });

    const mainThreadTick = new Promise<string>((resolve) => {
      setTimeout(() => resolve('responsive'), 50);
    });
    const winner = await Promise.race([
      mainThreadTick,
      slowQuery.then(
        () => 'query',
        () => 'query'
      ),
    ]);
    expect(winner).toBe('responsive');

    await expect(slowQuery).rejects.toThrow('Query timed out');

    const fast = await service.query({
      scopeType: 'global',
      scopeValue: '',
      sql: 'SELECT * FROM rooms',
    });
    expect(fast.rowCount).toBe(2);

    service.close();
  });
});
