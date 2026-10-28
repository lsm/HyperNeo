import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { captureGitArtifact } from '../../../../src/lib/artifacts/git-capture';

class IdentityGateway extends DbGateway {
  writes = 0;
  failAt = 0;
  loseAt = 0;
  barrier: Promise<void> | null = null;
  events: string[] = [];
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== 'artifact.identity.ensure.write') return super.run(op, args);
    const index = ++this.writes;
    this.events.push(`identity:${index}`);
    if (this.barrier) await this.barrier;
    if (this.failAt === index) throw new Error('synthetic Git identity admission failure');
    const value = await super.run(op, args);
    if (this.loseAt === index)
      throw new Error('synthetic Git identity reply lost; outcome unknown');
    return value;
  }
}

describe('Git capture committed identity admission', () => {
  let main: Database;
  let worker: Database;
  let gateway: IdentityGateway;
  let root: string;
  let attempts: number;
  let currentCalls: number;
  let blobCalls: number;
  const plan = {
    repository: 'github.com/synthetic/fixture',
    sha: 'a'.repeat(40),
    path: 'report.md',
    context: { kind: 'todo' as const, id: 'synthetic-todo' },
  };
  const identity = () => worker.prepare('SELECT daemon_id FROM artifact_file_identity').get();
  const current = async () => {
    currentCalls++;
    return false;
  };
  const blob = async () => {
    blobCalls++;
    return { accepted: false as const, reason: 'unavailable' as const };
  };
  const invoke = (check = current) =>
    Promise.resolve().then(() =>
      captureGitArtifact(main, root, plan, 'synthetic-request', check, blob, join(root, 'home'))
    );
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-git-identity-')));
    main = new Database(':memory:');
    worker = new Database(':memory:');
    runMigrations(main, () => {});
    createTables(main);
    worker.exec(
      'CREATE TABLE artifact_file_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), daemon_id TEXT NOT NULL)'
    );
    gateway = new IdentityGateway(':memory:', worker);
    bindGateway(main, gateway);
    attempts = 0;
    currentCalls = 0;
    blobCalls = 0;
    const prepare = main.prepare;
    main.prepare = ((sql: string) => {
      if (
        /INSERT OR IGNORE INTO artifact_file_identity|SELECT daemon_id FROM artifact_file_identity/.test(
          sql
        )
      ) {
        attempts++;
        throw new Error('Git identity SQL reached main');
      }
      return prepare.call(main, sql);
    }) as typeof main.prepare;
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    worker.close();
    rmSync(root, { recursive: true, force: true });
  });
  test('current-source refusal happens after committed identity without main SQL or blob lookup', async () => {
    expect(await invoke()).toEqual({ accepted: false, reason: 'unavailable' });
    expect(identity()).toMatchObject({ daemon_id: expect.any(String) });
    expect(gateway.writes).toBe(1);
    expect(attempts).toBe(0);
    expect(currentCalls).toBe(1);
    expect(blobCalls).toBe(0);
  });
  test('reserves the per-database lane before awaiting identity and keeps explicit call order', async () => {
    let release = () => {};
    gateway.barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const outcomes = Promise.allSettled([
      invoke(async () => {
        gateway.events.push('a');
        return false;
      }),
      invoke(async () => {
        gateway.events.push('b');
        return false;
      }),
    ]);
    await new Promise((done) => setTimeout(done, 15));
    const beforeRelease = gateway.writes;
    release();
    const results = await outcomes;
    for (const result of results)
      expect(result).toEqual({
        status: 'fulfilled',
        value: { accepted: false, reason: 'unavailable' },
      });
    expect(beforeRelease).toBe(1);
    expect(gateway.events).toEqual(['identity:1', 'a', 'identity:2', 'b']);
    expect(attempts).toBe(0);
  });
  test('admission rejection invokes no callbacks and never automatically replays', async () => {
    gateway.failAt = 1;
    await expect(invoke()).rejects.toThrow('Git identity admission failure');
    expect(identity()).toBeNull();
    expect(currentCalls).toBe(0);
    expect(blobCalls).toBe(0);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.writes).toBe(1);
    expect(attempts).toBe(0);
    expect(await invoke()).toEqual({ accepted: false, reason: 'unavailable' });
    expect(gateway.writes).toBe(2);
  });
  test('unknown-outcome initialization retains its identity without callbacks, fallback or replay', async () => {
    gateway.loseAt = 1;
    await expect(invoke()).rejects.toThrow('outcome unknown');
    const committed = identity();
    expect(committed).toMatchObject({ daemon_id: expect.any(String) });
    expect(currentCalls).toBe(0);
    expect(blobCalls).toBe(0);
    expect(main.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()).toEqual({ n: 0 });
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.writes).toBe(1);
    expect(await invoke()).toEqual({ accepted: false, reason: 'unavailable' });
    expect(identity()).toEqual(committed);
    expect(gateway.writes).toBe(2);
    expect(attempts).toBe(0);
  });
  test('a failed request releases the lane for the next explicit request without replaying callbacks', async () => {
    gateway.failAt = 1;
    const results = await Promise.allSettled([invoke(), invoke()]);
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toEqual({
      status: 'fulfilled',
      value: { accepted: false, reason: 'unavailable' },
    });
    expect(gateway.writes).toBe(2);
    expect(currentCalls).toBe(1);
    expect(blobCalls).toBe(0);
    expect(attempts).toBe(0);
  });
});
