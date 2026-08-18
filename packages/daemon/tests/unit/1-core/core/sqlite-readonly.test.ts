import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
