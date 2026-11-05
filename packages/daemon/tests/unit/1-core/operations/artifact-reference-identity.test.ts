import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { createArtifactReferenceResolve } from '../../../../src/lib/artifacts/resolve-operation';

class AdmissionGateway extends DbGateway {
  writes = 0;
  failBefore = false;
  loseReply = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== 'artifact.identity.ensure.write') return super.run(op, args);
    this.writes++;
    if (this.failBefore) throw new Error('synthetic identity admission failure');
    const value = await super.run(op, args);
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('synthetic committed identity reply lost; outcome unknown');
    }
    return value;
  }
}

describe('artifact reference committed identity admission', () => {
  let main: Database;
  let worker: Database;
  let gateway: AdmissionGateway;
  let root: string;
  let attempts: number;
  let operation: ReturnType<typeof createArtifactReferenceResolve>;
  const input = {
    requestId: '11111111-1111-4111-8111-111111111111',
    sourceMessageOrCard: { kind: 'todo' as const, id: 'synthetic-missing' },
    reference: 'report.md',
  };
  const caller = { source: 'rpc' as const, principal: 'local' as const };
  const invoke = () => operation.execute(input, caller);
  const identity = () => worker.prepare('SELECT daemon_id FROM artifact_file_identity').get();
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-reference-identity-')));
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
        throw new Error('reference identity SQL reached main');
      }
      return prepare.call(main, sql);
    }) as typeof main.prepare;
    operation = createArtifactReferenceResolve(() => main, root, join(root, 'home'));
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    worker.close();
    rmSync(root, { recursive: true, force: true });
  });
  test('reference refusal retains the committed identity without main SQL', async () => {
    expect(await invoke()).toEqual({ accepted: false, reason: 'unavailable' });
    expect(identity()).toMatchObject({ daemon_id: expect.any(String) });
    expect(gateway.writes).toBe(1);
    expect(attempts).toBe(0);
    expect(await invoke()).toEqual({ accepted: false, reason: 'unavailable' });
    expect(gateway.writes).toBe(2);
  });
  test('non-human callers and discovery never initialize an identity', async () => {
    expect(gateway.writes).toBe(0);
    expect(
      await operation.execute(input, { source: 'mcp', role: 'neo', sessionId: 'neo' })
    ).toEqual({ accepted: false, reason: 'unavailable' });
    expect(gateway.writes).toBe(0);
    expect(attempts).toBe(0);
  });
  test('concurrent explicit calls each initialize once and retain one identity', async () => {
    const results = await Promise.all([invoke(), invoke()]);
    for (const result of results)
      expect(result).toEqual({ accepted: false, reason: 'unavailable' });
    expect(gateway.writes).toBe(2);
    expect(worker.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()).toEqual({
      n: 1,
    });
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
    expect(await invoke()).toEqual({ accepted: false, reason: 'unavailable' });
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
    expect(await invoke()).toEqual({ accepted: false, reason: 'unavailable' });
    expect(identity()).toEqual(committed);
    expect(gateway.writes).toBe(2);
    expect(attempts).toBe(0);
  });
});
