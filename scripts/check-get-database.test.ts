import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const baselinePath = 'scripts/get-database-baseline.json';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'get-database-ratchet-'));
  roots.push(root);
  const put = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: root });
    expect(result.exitCode).toBe(0);
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  put('packages/daemon/src/main.ts', 'const db = getDatabase(); const other = ctx.getDatabase ();');
  put(baselinePath, JSON.stringify({ getDatabase: 2 }));
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'check-get-database.ts'), root, 'HEAD', ...args],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  const baseline = () => JSON.parse(readFileSync(join(root, baselinePath), 'utf8')).getDatabase;
  return { put, run, baseline };
}

test('an added getDatabase call fails the check', () => {
  const f = fixture();
  f.put('packages/daemon/src/new.ts', 'getDatabase();');
  const result = f.run();
  expect(result.output).toContain('getDatabase: 3 > baseline 2');
  expect(result.code).toBe(1);
});

test('unchanged source passes and test files are not counted', () => {
  const f = fixture();
  f.put('packages/daemon/src/main.test.ts', 'getDatabase(); getDatabase();');
  const result = f.run();
  expect(result.output).toContain('getDatabase: 2 (baseline 2)');
  expect(result.code).toBe(0);
});

test('a removed call must lower the baseline, and --update lowers it', () => {
  const f = fixture();
  f.put('packages/daemon/src/main.ts', 'const db = getDatabase();');
  const stale = f.run();
  expect(stale.output).toContain('lower the baseline to 1');
  expect(stale.code).toBe(1);
  expect(f.run('--update').code).toBe(0);
  expect(f.baseline()).toBe(1);
  expect(f.run().code).toBe(0);
});

test('--update cannot raise the baseline', () => {
  const f = fixture();
  f.put('packages/daemon/src/new.ts', 'getDatabase();');
  expect(f.run('--update').code).toBe(1);
  expect(f.baseline()).toBe(2);
});

test('raising the baseline by hand fails even if the source fits it', () => {
  const f = fixture();
  f.put('packages/daemon/src/new.ts', 'getDatabase();');
  f.put(baselinePath, JSON.stringify({ getDatabase: 3 }));
  const result = f.run();
  expect(result.output).toContain('baseline may only decrease (2 -> 3)');
  expect(result.code).toBe(1);
});

test('a missing comparison ref fails closed', () => {
  const f = fixture();
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'check-get-database.ts'), roots[0], 'missing-ref'],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  expect(f.run().code).toBe(0);
  expect(result.exitCode).toBe(1);
});

test('a malformed baseline cannot disable the guard', () => {
  const f = fixture();
  f.put(baselinePath, '{}');
  const result = f.run();
  expect(result.output).toContain('Invalid getDatabase baseline');
  expect(result.code).toBe(1);
});
