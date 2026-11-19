import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(initialMissing = false) {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-ratchet-'));
  roots.push(root);
  const put = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  put(
    'packages/demo/src/main.ts',
    `
    const run = superpipe({})('demo.run').end();
    defineOperation({ name: 'demo.run', execute: () => run() });
    transport.onRequest('demo.run', () => {});
  `
  );
  put(
    'scripts/pipeline-ratchet-baseline.json',
    JSON.stringify({ missing: initialMissing ? 1 : 0, misnamed: 0, dynamic: 0, unreadable: 0 })
  );
  if (initialMissing)
    put('packages/demo/src/extra.ts', `defineOperation({ name: 'demo.extra', execute: () => 1 });`);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git('init', '-q');
  git('add', '.');
  const tree = git('write-tree');
  const commit = git('commit-tree', tree, '-m', 'fixture');
  git('update-ref', 'HEAD', commit);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'check-pipeline-ratchet.ts'), root, 'HEAD', ...args],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  return { put, run };
}

test('the check passes at baseline', () => {
  const f = fixture();
  expect(f.run().code).toBe(0);
});

test.each([
  ['missing', `defineOperation({ name: 'demo.missing', execute: () => 1 });`],
  [
    'misnamed',
    `const other = superpipe({})('wrong.name').end(); defineOperation({ name: 'demo.other', execute: () => other() });`,
  ],
  ['dynamic', `transport.onRequest(methodName, () => {});`],
  ['dynamic', `const route = superpipe({})(makeName()).end();`],
  ['dynamic', `transport.onRequest('demo.' + suffix, () => {});`],
  ['unreadable', `defineOperation({ name: 'demo.unknown', execute: externalHandler });`],
])('the check fails when %s increases', (kind, source) => {
  const f = fixture();
  f.put('packages/demo/src/added.ts', source);
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain(kind);
});

test('raising the baseline cannot hide a regression', () => {
  const f = fixture();
  f.put('packages/demo/src/added.ts', `transport.onRequest(methodName, () => {});`);
  f.put(
    'scripts/pipeline-ratchet-baseline.json',
    JSON.stringify({ missing: 0, misnamed: 0, dynamic: 1, unreadable: 0 })
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('baseline may only decrease');
});

test('a malformed baseline fails closed', () => {
  const f = fixture();
  f.put('scripts/pipeline-ratchet-baseline.json', '{}');
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('Invalid pipeline ratchet baseline');
});

test('a pipeline in another function cannot hide an unreadable route', () => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `
    function unrelated() { const run = superpipe({})('demo.hidden').end(); }
    function operation(run) { return defineOperation({ name: 'demo.hidden', execute: () => run() }); }
  `
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('unreadable');
});

test.each(['service.run()', 'service?.run()'])(
  'a member call %s cannot be mistaken for a local pipeline',
  (call) => {
    const f = fixture();
    f.put(
      'packages/demo/src/added.ts',
      `
      const run = superpipe({})('demo.member').end();
      defineOperation({ name: 'demo.member', execute: () => ${call} });
    `
    );
    const result = f.run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('unreadable: 1 (baseline 0)');
  }
);

test('a forwarded name is unreadable rather than a constructed name', () => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `function forward(method, handler) { transport.onRequest(method, handler); }`
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('unreadable: 1 (baseline 0)');
  expect(result.output).toContain('dynamic: 0 (baseline 0)');
});

test('a decrease requires lowering the baseline', () => {
  const f = fixture(true);
  f.put('packages/demo/src/extra.ts', '');
  expect(f.run().code).toBe(1);
  expect(f.run('--update').code).toBe(0);
  expect(f.run().code).toBe(0);
});

test('update cannot hide an increase', () => {
  const f = fixture();
  f.put('packages/demo/src/added.ts', `transport.onRequest(methodName, () => {});`);
  expect(f.run('--update').code).toBe(1);
});
