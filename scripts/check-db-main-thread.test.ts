import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'db-ratchet-'));
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
  put('packages/daemon/src/main.ts', "db.prepare('SELECT 1');");
  const baseline = { prepare: 1, transaction: 0, exec: 0, query: 0, run: 0, open: 0 };
  const save = () => put('scripts/db-main-thread-baseline.json', JSON.stringify(baseline));
  save();
  git('add', '.');
  git('commit', '-qm', 'baseline');
  const run = (ref = 'HEAD') => {
    const result = Bun.spawnSync(
      [process.execPath, resolve('scripts/check-db-main-thread.ts'), root, ref],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  return { put, run, baseline, save };
}

test('the CI command rejects an added main-thread prepare', () => {
  const f = fixture();
  f.put('packages/daemon/src/new.ts', "db.prepare ('SELECT 2'); db.prepare('SELECT 3');");
  const result = f.run();
  expect(result.output).toContain('prepare: 3 > baseline 1');
  expect(result.code).toBe(1);
});

test('unchanged source passes; schema and actual worker entrypoints are excluded', () => {
  const f = fixture();
  f.put('packages/daemon/src/storage/schema/m999.ts', 'db.prepare(); db.transaction();');
  f.put('packages/daemon/src/storage/db-gateway/db-gateway-worker.ts', 'db.prepare();');
  expect(f.run().code).toBe(0);
});

test('a file merely named worker is still counted', () => {
  const f = fixture();
  f.put('packages/daemon/src/new-worker.tsx', 'db.prepare\n();');
  expect(f.run().code).toBe(1);
});

for (const source of ['db.transaction();', 'db.exec();', 'db.query();', 'db.run();', 'new Database();', 'new DatabaseSync();']) {
  test(`the CI command rejects equivalent sync entrypoint: ${source}`, () => {
    const f = fixture();
    f.put('packages/daemon/src/new.ts', source);
    expect(f.run().code).toBe(1);
  });
}

test('raising the baseline fails even if the source fits the new ceiling', () => {
  const f = fixture();
  f.baseline.prepare = 2;
  f.save();
  const result = f.run();
  expect(result.output).toContain('baseline prepare may only decrease');
  expect(result.code).toBe(1);
});

test('lowering the baseline passes after removing calls', () => {
  const f = fixture();
  f.put('packages/daemon/src/main.ts', '');
  f.baseline.prepare = 0;
  f.save();
  expect(f.run().code).toBe(0);
});

test('missing comparison ref fails closed', () => {
  expect(fixture().run('missing-ref').code).toBe(1);
});
