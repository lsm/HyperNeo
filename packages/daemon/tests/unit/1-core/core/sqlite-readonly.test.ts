/**
 * Regression guard for the cross-runtime `readonly` SQLite open option.
 *
 * bun:sqlite and node:sqlite disagree on the spelling:
 *   - bun:sqlite accepts `readonly` and throws on `readOnly` ("Misspelled option").
 *   - node:sqlite accepts `readOnly` and silently ignores `readonly` (opens RW).
 *
 * Prod/dev run under Bun, so call sites use `readonly` and `sqlite-node.ts`
 * normalizes it to `readOnly` for the Node (test/tsx) path. This test pins the
 * Node-side normalization: `{ readonly: true }` must actually open read-only.
 * (The Bun spelling is covered by the runtime itself.)
 */
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
    // Populate read-write first (a readonly open of a missing file fails).
    const rw = new Database(path);
    rw.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);');
    rw.close();

    const ro = new Database(path, { readonly: true });
    const row = ro.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number } | null;
    expect(row?.n).toBe(1);

    // If the Node wrapper failed to normalize `readonly` -> `readOnly`, node:sqlite
    // would silently open read-write and this INSERT would succeed.
    expect(() => ro.exec('INSERT INTO t VALUES (2)')).toThrow();
    ro.close();
  });
});
