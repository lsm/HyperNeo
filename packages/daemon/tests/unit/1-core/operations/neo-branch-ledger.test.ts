import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGithubBranchPrs } from '../../../../src/lib/neo/packs/coding/branch-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/ledger/pull/7';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'branch-ledger-'));
  const checkout = (name: string) => {
    const cwd = join(root, name);
    mkdirSync(cwd);
    execFileSync('git', ['init', '-b', 'feature'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/Synthetic/Ledger.git'], {
      cwd,
      stdio: 'pipe',
    });
    return { cwd, branch: 'feature' };
  };
  const db = new Database(join(root, 'facts.db'));
  createCodingPackTables(db);
  let calls = 0;
  const spawn: SpawnFn = () => {
    calls++;
    return {
      stdout: new Response(JSON.stringify([{ url }])).body,
      stderr: new Response('').body,
      exited: new Promise<number>((done) => setTimeout(() => done(0), 20)),
      exitCode: null,
      kill: () => {},
    };
  };
  const reader = (_db: Database) => (query: { cwd: string; branch: string }) =>
    readGithubBranchPrs(query, spawn);
  return {
    root,
    db,
    checkout,
    reader,
    calls: () => calls,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('ledger branch reader', () => {
  test('simultaneous requests for one branch share one upstream read', async () => {
    const f = fixture();
    try {
      const query = f.checkout('one'),
        read = f.reader(f.db);
      expect(await Promise.all(Array.from({ length: 5 }, () => read(query)))).toEqual(
        Array.from({ length: 5 }, () => [url])
      );
      expect(f.calls()).toBe(1);
    } finally {
      f.cleanup();
    }
  });
  test('a second checkout and a reopened collector use persisted repository coverage', async () => {
    const f = fixture();
    try {
      const read = f.reader(f.db);
      expect(await read(f.checkout('one'))).toEqual([url]);
      expect(await read(f.checkout('two'))).toEqual([url]);
      expect(f.calls()).toBe(1);
      const reopened = new Database(join(f.root, 'facts.db'));
      try {
        expect(await f.reader(reopened)(f.checkout('three'))).toEqual([url]);
        expect(f.calls()).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      f.cleanup();
    }
  });
});
