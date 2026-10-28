import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createArtifactRegistration } from '../../../../src/lib/artifacts/register-operation';

class AdmissionGateway extends DbGateway {
  writes = 0;
  failBefore = false;
  loseReply = false;
  barrier: Promise<void> | null = null;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== 'artifact.identity.ensure.write') return super.run(op, args);
    this.writes++;
    if (this.barrier) await this.barrier;
    if (this.failBefore) throw new Error('synthetic identity admission failure');
    const value = await super.run(op, args);
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('synthetic committed identity reply lost; outcome unknown');
    }
    return value;
  }
}

describe('artifact registration committed identity admission', () => {
  let main: Database;
  let worker: Database;
  let gateway: AdmissionGateway;
  let root: string;
  let attempts: number;
  let operation: ReturnType<typeof createArtifactRegistration>;
  const input = {
    requestId: 'synthetic-request',
    context: { kind: 'ask' as const, id: 'synthetic-caller' },
    path: '../refused.md',
    title: 'Synthetic',
  };
  const caller = {
    source: 'mcp' as const,
    role: 'direct_task_worker' as const,
    sessionId: input.context.id,
  };
  const invoke = () => operation.execute(input, caller);
  const identity = () => worker.prepare('SELECT daemon_id FROM artifact_file_identity').get();
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-registration-identity-')));
    main = new Database(':memory:');
    worker = new Database(':memory:');
    runMigrations(main, () => {});
    createTables(main);
    worker.exec(
      'CREATE TABLE artifact_file_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), daemon_id TEXT NOT NULL)'
    );
    gateway = new AdmissionGateway(':memory:', worker);
    bindGateway(main, gateway);
    attempts = 0;
    const prepare = main.prepare;
    main.prepare = ((sql: string) => {
      if (
        /INSERT OR IGNORE INTO artifact_file_identity|SELECT daemon_id FROM artifact_file_identity/.test(
          sql
        )
      ) {
        attempts++;
        throw new Error('registration identity SQL reached main');
      }
      return prepare.call(main, sql);
    }) as typeof main.prepare;
    operation = createArtifactRegistration(() => main, root, join(root, 'home'));
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    worker.close();
    rmSync(root, { recursive: true, force: true });
  });
  test('registration waits for the committed identity without main SQL', async () => {
    expect(await invoke()).toEqual({ accepted: false, reason: 'unsafe_path' });
    expect(identity()).toMatchObject({ daemon_id: expect.any(String) });
    expect(gateway.writes).toBe(1);
    expect(attempts).toBe(0);
    expect(await invoke()).toEqual({ accepted: false, reason: 'unsafe_path' });
    expect(gateway.writes).toBe(1);
  });
  test('concurrent first calls share one pending initialization', async () => {
    let release = () => {};
    gateway.barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const results = Promise.allSettled([invoke(), invoke(), invoke()]);
    await new Promise((done) => setTimeout(done, 10));
    const posts = gateway.writes;
    release();
    const outcomes = await results;
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes)
      expect(outcome).toEqual({
        status: 'fulfilled',
        value: { accepted: false, reason: 'unsafe_path' },
      });
    expect(posts).toBe(1);
    expect(gateway.writes).toBe(1);
    expect(attempts).toBe(0);
  });
  test('admission failure does not initialize on main or automatically replay', async () => {
    gateway.failBefore = true;
    await expect(invoke()).rejects.toThrow('identity admission failure');
    expect(identity()).toBeNull();
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.writes).toBe(1);
    expect(attempts).toBe(0);
    gateway.failBefore = false;
    expect(await invoke()).toEqual({ accepted: false, reason: 'unsafe_path' });
    expect(gateway.writes).toBe(2);
  });
  test('unknown-outcome initialization is never replayed and an explicit later call retains its receipt', async () => {
    gateway.loseReply = true;
    await expect(invoke()).rejects.toThrow('outcome unknown');
    const committed = identity();
    expect(committed).toMatchObject({ daemon_id: expect.any(String) });
    expect(main.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()).toEqual({ n: 0 });
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.writes).toBe(1);
    expect(await invoke()).toEqual({ accepted: false, reason: 'unsafe_path' });
    expect(identity()).toEqual(committed);
    expect(gateway.writes).toBe(2);
    expect(attempts).toBe(0);
  });
  test('shared initialization failure rejects every caller and does not poison later explicit calls', async () => {
    gateway.failBefore = true;
    const results = await Promise.allSettled([invoke(), invoke()]);
    expect(
      results.every(
        (result) =>
          result.status === 'rejected' &&
          String(result.reason).includes('identity admission failure')
      )
    ).toBe(true);
    expect(gateway.writes).toBe(1);
    expect(attempts).toBe(0);
    gateway.failBefore = false;
    expect(await invoke()).toEqual({ accepted: false, reason: 'unsafe_path' });
    expect(gateway.writes).toBe(2);
  });
});
