import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
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
    JSON.stringify({ missing: 0, misnamed: 0, dynamic: 0, unreadable: 0 })
  );
  const run = () => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'check-pipeline-ratchet.ts'), root],
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
  ['unreadable', `defineOperation({ name: 'demo.unknown', execute: externalHandler });`],
])('the check fails when %s increases', (kind, source) => {
  const f = fixture();
  f.put('packages/demo/src/added.ts', source);
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain(kind);
});
