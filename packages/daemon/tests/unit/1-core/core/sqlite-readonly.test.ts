import { describe, it, expect, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('sqlite compat: readonly option (cross-runtime)', () => {
  const path = join(tmpdir(), `hyperneo-readonly-${process.pid}.db`);

  afterEach(() => {
    for (const p of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it('opens read-only with { readonly: true }, blocking writes', () => {
    const rw = new Database(path);
    rw.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);');
    rw.close();

    const ro = new Database(path, { readonly: true });
    const row = ro.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number } | null;
    expect(row?.n).toBe(1);

    expect(() => ro.exec('INSERT INTO t VALUES (2)')).toThrow();
    ro.close();
  });

  it('layering PRAGMA query_only reports the flag and still blocks writes', () => {
    const rw = new Database(path);
    rw.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);');
    rw.close();

    const ro = new Database(path, { readonly: true });
    ro.exec('PRAGMA query_only = ON');
    const flag = ro.prepare('PRAGMA query_only').get() as {
      query_only?: number | string | boolean;
    } | null;
    expect(flag?.query_only === 1 || flag?.query_only === '1' || flag?.query_only === true).toBe(
      true
    );
    expect(() => ro.exec('INSERT INTO t VALUES (3)')).toThrow();
    ro.close();
  });

  it('opens an encoded immutable WAL database without creating sidecars', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyperneo-readonly-uri-'));
    const filename = 'Desktop ?#.db';
    const file = join(dir, filename);
    try {
      const db = new Database(file);
      db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (42);');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      rmSync(`${file}-wal`, { force: true });
      rmSync(`${file}-shm`, { force: true });
      const before = readFileSync(file);
      chmodSync(dir, 0o555);
      const uri = pathToFileURL(file);
      uri.searchParams.set('immutable', '1');
      const reader = new Database(uri.href, { readonlyUri: true });
      try {
        expect(reader.prepare('SELECT x FROM t').get()).toEqual({ x: 42 });
        expect(() => reader.exec('INSERT INTO t VALUES (2)')).toThrow();
      } finally {
        reader.close();
      }
      expect(readdirSync(dir)).toEqual([filename]);
      expect(readFileSync(file)).toEqual(before);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
