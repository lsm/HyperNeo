import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { ArtifactRef, ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import type { ArtifactBundleEntry } from '../../../../src/lib/artifacts/bundle';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigration432 } from '../../../../src/storage/schema/m432-artifact-files';
import { ArtifactFileRepository } from '../../../../src/storage/repositories/artifact-file-repository';

type Serialize = (
  artifact: ArtifactRef,
  revision?: ArtifactFileMetadata['revision'],
  bundle?: readonly ArtifactBundleEntry[],
  logicalRequestId?: string
) => string;
const artifact: ArtifactRef = {
  daemonId: '11111111-1111-4111-8111-111111111111',
  artifactId: 'SyntheticArtifact',
  title: 'Synthetic',
  kind: 'markdown',
  byteLength: 3,
};
const context = { kind: 'ask' as const, id: 'synthetic-context' };
const legacy = JSON.stringify({ accepted: true, artifact });
async function serializer(): Promise<Serialize> {
  const file = new URL(
    '../../../../src/storage/repositories/artifact-file-receipt.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Canonical artifact receipt serializer is unavailable');
  const module = (await import(file.href)) as { serializeArtifactReceipt?: Serialize };
  if (typeof module.serializeArtifactReceipt !== 'function')
    throw new Error('Canonical artifact receipt serializer is unavailable');
  return module.serializeArtifactReceipt;
}
describe('canonical artifact receipt extraction', () => {
  let db: Database;
  let repo: ArtifactFileRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigration432(db);
    repo = new ArtifactFileRepository(db, artifact.daemonId);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const stored = (id = artifact.artifactId) =>
    db.prepare('SELECT receipt, created_at FROM artifact_files WHERE artifact_id=?').get(id) as {
      receipt: string;
      created_at: number;
    } | null;
  const save = (
    value = artifact,
    revision?: ArtifactFileMetadata['revision'],
    bundle?: readonly ArtifactBundleEntry[],
    logical?: string
  ) =>
    repo.save(
      context,
      value.artifactId,
      'fingerprint',
      'sha',
      value,
      '{"adapter":"hyperneo","id":"synthetic"}',
      'report.md',
      revision,
      bundle,
      logical
    );
  test('legacy save retains literal receipt bytes, return reference and timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(77);
    const result = save();
    expect(result).toEqual({ accepted: true, artifact });
    expect(result.artifact).toBe(artifact);
    expect(stored()).toEqual({ receipt: legacy, created_at: 77 });
  });
  test('legacy caller-owned rollback leaves no immutable row', () => {
    expect(() =>
      db.transaction(() => {
        save();
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(stored()).toBeNull();
  });
  test('serializer produces exact legacy bytes without clock, SQL or input mutation', async () => {
    const serialize = await serializer();
    const clock = vi.spyOn(Date, 'now');
    const immutable = Object.freeze({ ...artifact });
    expect(serialize(immutable)).toBe(legacy);
    expect(clock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get()).toEqual({ n: 0 });
  });
  test('serializer and legacy save preserve optional-field bytes and ordering', async () => {
    const serialize = await serializer();
    const cases: {
      revision?: ArtifactFileMetadata['revision'];
      bundle?: ArtifactBundleEntry[];
      logical?: string;
      suffix: string;
    }[] = [
      { suffix: '' },
      { logical: '', suffix: '' },
      { logical: 'logical-request', suffix: 'logical' },
      { revision: { kind: 'worktree' }, suffix: 'worktree' },
      { bundle: [], suffix: 'empty-bundle' },
      {
        revision: {
          kind: 'commit',
          repository: 'github.com/synthetic/fixture',
          commitSha: 'a'.repeat(40),
          blobSha: 'b'.repeat(40),
        },
        bundle: [{ path: 'style.css', artifactId: 'SyntheticCss' }],
        logical: 'logical-request',
        suffix: 'all',
      },
    ];
    for (const [index, value] of cases.entries()) {
      const ref = { ...artifact, artifactId: `Synthetic${index}` };
      save(ref, value.revision, value.bundle, value.logical);
      const encoded = serialize(ref, value.revision, value.bundle, value.logical);
      expect(encoded).toBe(stored(ref.artifactId)!.receipt);
      expect(Object.keys(JSON.parse(encoded))).toEqual([
        'accepted',
        ...(value.logical ? ['requestId'] : []),
        'artifact',
        ...(value.revision ? ['revision'] : []),
        ...(value.bundle ? ['bundle'] : []),
      ]);
      if (value.suffix === 'logical')
        expect(encoded).toBe(
          `{"accepted":true,"requestId":"logical-request","artifact":${JSON.stringify(ref)}}`
        );
      if (value.suffix === 'empty-bundle')
        expect(encoded).toBe(`{"accepted":true,"artifact":${JSON.stringify(ref)},"bundle":[]}`);
    }
  });
  test('save preserves prepare, serialization, clock and execution order', () => {
    const events: string[] = [];
    const prepare = db.prepare;
    db.prepare = ((sql: string) => {
      if (!sql.startsWith('INSERT INTO artifact_files')) return prepare.call(db, sql);
      events.push('prepare');
      const statement = prepare.call(db, sql);
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (key === 'run') events.push('run');
            return Reflect.apply(value, target, args);
          };
        },
      });
    }) as typeof db.prepare;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      events.push('now');
      return 88;
    });
    const ref = {
      ...artifact,
      toJSON() {
        events.push('serialize');
        return artifact;
      },
    };
    save(ref);
    expect(events).toEqual(['prepare', 'serialize', 'now', 'run']);
    expect(stored()).toEqual({ receipt: legacy, created_at: 88 });
  });
  test('serialization failure occurs before clock/write and is propagated by both entrypoints', async () => {
    const serialize = await serializer();
    const clock = vi.spyOn(Date, 'now');
    const ref = {
      ...artifact,
      toJSON() {
        throw new Error('synthetic serialization failure');
      },
    };
    expect(() => serialize(ref)).toThrow('synthetic serialization failure');
    expect(() => save(ref)).toThrow('synthetic serialization failure');
    expect(clock).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });
});
