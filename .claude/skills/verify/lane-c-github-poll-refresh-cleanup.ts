import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock } from 'bun:test';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const owned = new Set(['data', 'home', 'workspace'].map((name) => join(run, name)));
const remove = fs.rmSync;
let attempted = false;
const guardedRemove: typeof fs.rmSync = (path, options) => {
  if (owned.has(resolve(String(path)))) {
    attempted = true;
    throw Object.assign(new Error('ENOTEMPTY: synthetic writer still owns helper data'), { code: 'ENOTEMPTY' });
  }
  return remove(path, options);
};
mock.module('node:fs', () => ({ ...fs, default: fs, rmSync: guardedRemove }));
try {
  await import('./lane-c-github-poll-refresh-retry.ts');
  assert.equal(attempted, false);
  assert(fs.existsSync(join(run, 'evidence/github-poll-refresh-retry.json')));
  console.log('PASS: real settings RPC retry journey saves evidence without deleting data before its process exits');
} finally {
  mock.restore();
  fs.writeFileSync(join(run, 'evidence/cleanup-ownership.json'), JSON.stringify({ helperAttemptedDataDeletion: attempted, parentOwnsDeletionAfterExit: true }));
}
