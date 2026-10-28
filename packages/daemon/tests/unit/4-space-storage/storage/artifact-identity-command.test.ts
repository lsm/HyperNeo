import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { ensureArtifactFileIdentity } from '../../../../src/storage/repositories/artifact-file-identity';
import { ArtifactFileRepository } from '../../../../src/storage/repositories/artifact-file-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

const opName = 'artifact.identity.ensure.write';
class FaultGateway extends DbGateway {
  writes = 0;
  failBefore = false;
  loseReply = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== opName) return super.run(op, args);
    this.writes++;
    if (this.failBefore) throw new Error('synthetic identity admission failure');
    const result = await super.run(op, args);
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('synthetic identity committed reply lost; outcome unknown');
    }
    return result;
  }
}
describe('artifact identity writer construction', () => {
  let db: Database;
  let main: Database;
  let gateway: FaultGateway;
  const candidate = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  beforeEach(() => {
    db = new Database(':memory:');
    main = new Database(':memory:');
    db.exec(
      'CREATE TABLE artifact_file_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), daemon_id TEXT NOT NULL)'
    );
    gateway = new FaultGateway(':memory:', db);
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    db.close();
  });
  const retained = () =>
    (
      db.prepare('SELECT daemon_id FROM artifact_file_identity').get() as {
        daemon_id: string;
      } | null
    )?.daemon_id;
  const ensure = async (id = candidate): Promise<string> => {
    const op = DB_OPS.get(opName);
    if (!op) throw new Error('Unknown DB operation: ' + opName);
    return await gateway.run(op as DbOp<unknown, string>, { method: 'ensure', args: [id] });
  };
  test('legacy helper and constructor keep their default UUID and retained singleton', () => {
    const id = ensureArtifactFileIdentity(db);
    expect(id).toMatch(/^[\da-f-]{36}$/);
    expect(new ArtifactFileRepository(db).daemonId).toBe(id);
    expect(retained()).toBe(id);
  });
  test('helper accepts a caller candidate without changing default behavior', () => {
    expect(Reflect.apply(ensureArtifactFileIdentity, undefined, [db, candidate])).toBe(candidate);
    expect(Reflect.apply(ensureArtifactFileIdentity, undefined, [db, other])).toBe(candidate);
    expect(ensureArtifactFileIdentity(db)).toBe(candidate);
  });
  test('registered command returns exactly its committed identity', async () => {
    expect(await ensure()).toBe(candidate);
    expect(DB_OPS.get(opName)?.mode).toBe('write');
    expect(retained()).toBe(candidate);
    expect(structuredClone(await ensure(other))).toBe(candidate);
    expect(gateway.writes).toBe(2);
  });
  test('concurrent candidates retain one winning singleton', async () => {
    const ids = [candidate, other, '33333333-3333-4333-8333-333333333333'];
    const replies = await Promise.all(ids.map((id) => ensure(id)));
    expect(replies).toEqual([candidate, candidate, candidate]);
    expect(retained()).toBe(candidate);
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()).toEqual({ n: 1 });
  });
  test('committed-identity constructor seam never executes identity SQL', async () => {
    const committed = await ensure();
    let attempts = 0;
    main.prepare = () => {
      attempts++;
      throw new Error('identity SQL reached main');
    };
    const repository = Reflect.construct(ArtifactFileRepository, [
      main,
      committed,
    ]) as ArtifactFileRepository;
    expect(repository.daemonId).toBe(committed);
    expect(attempts).toBe(0);
  });
  test('receipt lookup failure rolls back a newly inserted identity', async () => {
    const saved = db.prepare;
    db.prepare = ((sql: string) => {
      const stmt = saved.call(db, sql);
      if (sql !== 'SELECT daemon_id FROM artifact_file_identity') return stmt;
      return new Proxy(stmt, {
        get(target, key) {
          if (key === 'get')
            return () => {
              throw new Error('synthetic identity receipt failure');
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof db.prepare;
    try {
      await expect(ensure()).rejects.toThrow('synthetic identity receipt failure');
    } finally {
      db.prepare = saved;
    }
    expect(retained()).toBeUndefined();
    expect(gateway.writes).toBe(1);
  });
  test('missing receipt rolls back trigger effects too', async () => {
    db.exec(
      'CREATE TABLE identity_effects(value INTEGER); CREATE TRIGGER hide_identity AFTER INSERT ON artifact_file_identity BEGIN INSERT INTO identity_effects VALUES(1); DELETE FROM artifact_file_identity WHERE singleton=NEW.singleton; END'
    );
    await expect(ensure()).rejects.toThrow(/daemon_id|null|undefined/);
    expect(retained()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM identity_effects').get()).toEqual({ n: 0 });
  });
  test('admission rejection preserves any retained identity without replay', async () => {
    const before = ensureArtifactFileIdentity(db);
    gateway.failBefore = true;
    await expect(ensure()).rejects.toThrow('admission failure');
    expect(retained()).toBe(before);
    expect(gateway.writes).toBe(1);
  });
  test('lost initial commit reply keeps the candidate and is never automatically replayed', async () => {
    gateway.loseReply = true;
    await expect(ensure()).rejects.toThrow('outcome unknown');
    expect(retained()).toBe(candidate);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.writes).toBe(1);
    expect(await ensure(other)).toBe(candidate);
    expect(gateway.writes).toBe(2);
  });
});
