import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('core consumes injected packs without importing any pack implementations', () => {
  const root = resolve(import.meta.dirname, '../../../../../..');
  const result = spawnSync('bun', ['scripts/check-neo-pack-imports.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
