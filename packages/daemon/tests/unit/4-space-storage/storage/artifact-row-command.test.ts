import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigration432 } from '../../../../src/storage/schema/m432-artifact-files';
import { ArtifactFileRepository } from '../../../../src/storage/repositories/artifact-file-repository';
import { serializeArtifactReceipt } from '../../../../src/storage/repositories/artifact-file-receipt';
import { ChangeRecorder, type DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';

type Args = Parameters<ArtifactFileRepository['save']>;
const artifact: ArtifactRef = {
  daemonId: '11111111-1111-4111-8111-111111111111',
  artifactId: 'SyntheticRow',
  title: 'Synthetic 🦊',
  kind: 'markdown',
  byteLength: 3,
};
const args = (id = artifact.artifactId, request = id): Args => [
  { kind: 'ask', id: 'synthetic-context' },
  request,
  'fingerprint',
  'sha',
  { ...artifact, artifactId: id },
  '{"adapter":"hyperneo","id":"synthetic"}',
  'report.md',
  { kind: 'worktree' },
  undefined,
  'logical-request',
];
async function command() {
  const file = new URL(
    '../../../../src/storage/repositories/artifact-file-row-write.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Artifact row writer is unavailable');
  const module = (await import(file.href)) as {
    artifactFileRowWrites: DbOp<{ method: string; args: Args }, unknown>;
  };
  return module.artifactFileRowWrites;
}

describe('artifact row publication writer', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigration432(db);
    vi.spyOn(Date, 'now').mockReturnValue(77);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const rows = () => db.prepare('SELECT * FROM artifact_files').all() as Record<string, unknown>[];
  const execute = async (values = args()) => {
    const op = await command();
    const changes = new ChangeRecorder();
    const result = db.transaction(() => op.run(db, { method: 'publish', args: values }, changes))();
    expect(changes.changes).toEqual([]);
    return result;
  };
  test('legacy save records the immutable publication fixture', () => {
    const values = args();
    const result = new ArtifactFileRepository(db, artifact.daemonId).save(...values);
    expect(result.artifact).toBe(values[4]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].created_at).toBe(77);
  });
  test('registered data-only writer retains exact rows and canonical receipt variants', async () => {
    const op = await command();
    expect(op.mode).toBe('write');
    expect(DB_OPS.get(op.name)).toBe(op);
    const cases: Pick<Args, 7 | 8 | 9>[] = [
      { 7: undefined, 8: undefined, 9: undefined },
      { 7: undefined, 8: undefined, 9: '' },
      { 7: undefined, 8: undefined, 9: 'logical-request' },
      { 7: { kind: 'worktree' }, 8: undefined, 9: undefined },
      { 7: undefined, 8: [], 9: undefined },
      {
        7: {
          kind: 'commit',
          repository: 'github.com/synthetic/fixture',
          commitSha: 'a'.repeat(40),
          blobSha: 'b'.repeat(40),
        },
        8: [{ path: 'style.css', artifactId: 'SyntheticCss' }],
        9: 'logical-request',
      },
    ];
    for (const [index, optional] of cases.entries()) {
      const values = Object.assign(args(`Synthetic${index}`), optional);
      const receipt = serializeArtifactReceipt(values[4], values[7], values[8], values[9]);
      expect(await execute(structuredClone(values))).toEqual({
        accepted: true,
        artifact: values[4],
        receipt,
        createdAt: 77,
      });
      expect(rows()[index]).toEqual({
        artifact_id: values[4].artifactId,
        context_kind: values[0].kind,
        context_id: values[0].id,
        request_id: values[1],
        fingerprint: values[2],
        sha256: values[3],
        byte_length: values[4].byteLength,
        receipt,
        producer_ref: values[5],
        source_path: values[6],
        created_at: 77,
      });
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()).toEqual({ n: 0 });
  });
  test('duplicate request or artifact never overwrites an immutable row', async () => {
    await execute();
    const retained = rows();
    await expect(execute(args('OtherArtifact', artifact.artifactId))).rejects.toThrow();
    await expect(execute(args(artifact.artifactId, 'other-request'))).rejects.toThrow();
    expect(rows()).toEqual(retained);
  });
  test('receipt lookup failure rolls back the row and trigger effects', async () => {
    db.exec(
      'CREATE TABLE synthetic_effects(value INTEGER); CREATE TRIGGER record_effect AFTER INSERT ON artifact_files BEGIN INSERT INTO synthetic_effects VALUES(1); END'
    );
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql, ...rest) => {
      if (sql === 'SELECT * FROM artifact_files WHERE artifact_id = ?')
        throw new Error('synthetic receipt lookup failure');
      return prepare(sql, ...rest);
    });
    await expect(execute()).rejects.toThrow('synthetic receipt lookup failure');
    expect(rows()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM synthetic_effects').get()).toEqual({ n: 0 });
  });
  test('missing or mismatched exact receipt rolls back publication and trigger effects', async () => {
    db.exec(
      'DROP TRIGGER immutable_artifact_file_update; DROP TRIGGER immutable_artifact_file_delete; CREATE TABLE synthetic_effects(value INTEGER)'
    );
    for (const mutation of [
      'DELETE FROM artifact_files WHERE artifact_id=NEW.artifact_id;',
      "UPDATE artifact_files SET receipt='{}' WHERE artifact_id=NEW.artifact_id;",
      "UPDATE artifact_files SET fingerprint='wrong' WHERE artifact_id=NEW.artifact_id;",
      "UPDATE artifact_files SET producer_ref='{}' WHERE artifact_id=NEW.artifact_id;",
    ]) {
      db.exec(
        `CREATE TRIGGER hide_receipt AFTER INSERT ON artifact_files BEGIN INSERT INTO synthetic_effects VALUES(1); ${mutation} END`
      );
      await expect(execute()).rejects.toThrow('Artifact publication receipt mismatch');
      expect(rows()).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM synthetic_effects').get()).toEqual({ n: 0 });
      db.exec('DROP TRIGGER hide_receipt');
    }
  });
  test('unknown repository method cannot publish a row', async () => {
    const op = await command();
    expect(() =>
      op.run(db, { method: 'unexpected', args: args() }, new ChangeRecorder())
    ).toThrow();
    expect(rows()).toEqual([]);
  });
});
