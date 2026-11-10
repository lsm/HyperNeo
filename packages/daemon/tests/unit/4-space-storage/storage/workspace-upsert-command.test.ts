import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { workspaceHistoryUpsertWrites } from '../../../../src/storage/repositories/workspace-history-upsert-write';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import {
  WorkspaceHistoryRepository,
  type WorkspaceHistoryRow,
} from '../../../../src/storage/repositories/workspace-history-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

class FaultGateway extends DbGateway {
  writes = 0;
  failBefore = false;
  loseReply = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== 'workspace.history.upsert.write') return super.run(op, args);
    this.writes++;
    if (this.failBefore) throw new Error('synthetic upsert admission failure');
    const result = await super.run(op, args);
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('synthetic committed upsert reply lost; outcome unknown');
    }
    return result;
  }
}

describe('workspace history upsert command construction', () => {
  let db: Database;
  let repo: WorkspaceHistoryRepository;
  let gateway: FaultGateway;
  const path = '/synthetic/workspace';
  const clock = 1_000_000;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    repo = new WorkspaceHistoryRepository(db);
    gateway = new FaultGateway(':memory:', db);
    vi.spyOn(Date, 'now').mockReturnValue(clock);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
    vi.restoreAllMocks();
  });
  const upsert = (target = path, now = clock): Promise<WorkspaceHistoryRow> =>
    gateway.call(workspaceHistoryUpsertWrites, 'upsert', target, now);
  test('legacy upsert(path) keeps its default clock and repeat counter', () => {
    expect(repo.upsert(path)).toEqual({ path, last_used_at: clock, use_count: 1 });
    vi.mocked(Date.now).mockReturnValue(clock + 10);
    expect(repo.upsert(path)).toEqual({ path, last_used_at: clock + 10, use_count: 2 });
  });
  test('the registered command returns a committed cloneable row using the supplied time', async () => {
    expect(DB_OPS.get('workspace.history.upsert.write')?.mode).toBe('write');
    const receipt = await upsert(path, clock + 23);
    expect(receipt).toEqual({ path, last_used_at: clock + 23, use_count: 1 });
    expect(repo.get(path)).toEqual(receipt);
    expect(structuredClone(receipt)).toEqual(receipt);
  });
  test('each command increments once and returns its own row and time', async () => {
    expect(await upsert(path, clock + 1)).toEqual({ path, last_used_at: clock + 1, use_count: 1 });
    expect(await upsert(path, clock + 2)).toEqual({ path, last_used_at: clock + 2, use_count: 2 });
  });
  test('concurrent increments return distinct committed counters', async () => {
    const receipts = await Promise.all([1, 2, 3, 4].map((offset) => upsert(path, clock + offset)));
    expect(receipts.map((r) => r.use_count).sort()).toEqual([1, 2, 3, 4]);
    expect(receipts.map((r) => r.last_used_at)).toEqual([1, 2, 3, 4].map((n) => clock + n));
    expect(repo.get(path)).toEqual({ path, last_used_at: clock + 4, use_count: 4 });
    expect(gateway.writes).toBe(4);
  });
  test('metadata paths are bound literally', async () => {
    const target = "/synthetic/quoted-'工作区";
    expect(await upsert(target, clock)).toEqual({
      path: target,
      last_used_at: clock,
      use_count: 1,
    });
    expect(repo.listAll()).toHaveLength(1);
  });
  test('receipt-read failure rolls back both a new row and an existing counter update', async () => {
    vi.spyOn(WorkspaceHistoryRepository.prototype, 'get').mockImplementationOnce(() => {
      throw new Error('synthetic receipt read failure');
    });
    await expect(upsert()).rejects.toThrow('synthetic receipt read failure');
    expect(repo.get(path)).toBeNull();
    repo.upsert(path);
    vi.mocked(WorkspaceHistoryRepository.prototype.get).mockImplementationOnce(() => {
      throw new Error('synthetic receipt read failure');
    });
    await expect(upsert(path, clock + 10)).rejects.toThrow('synthetic receipt read failure');
    expect(repo.get(path)).toEqual({ path, last_used_at: clock, use_count: 1 });
  });
  test('admission failure leaves the counter and timestamp unchanged', async () => {
    repo.upsert(path);
    gateway.failBefore = true;
    await expect(upsert(path, clock + 10)).rejects.toThrow('synthetic upsert admission failure');
    expect(repo.get(path)).toEqual({ path, last_used_at: clock, use_count: 1 });
    expect(gateway.writes).toBe(1);
  });
  test('an unknown commit error never automatically increments twice', async () => {
    gateway.loseReply = true;
    await expect(upsert()).rejects.toThrow('outcome unknown');
    expect(repo.get(path)).toEqual({ path, last_used_at: clock, use_count: 1 });
    await new Promise((done) => setTimeout(done, 50));
    expect(gateway.writes).toBe(1);
    expect(await upsert(path, clock + 10)).toEqual({
      path,
      last_used_at: clock + 10,
      use_count: 2,
    });
    expect(gateway.writes).toBe(2);
  });
});
