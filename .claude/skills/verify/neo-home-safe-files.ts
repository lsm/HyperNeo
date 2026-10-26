import { strict as assert } from 'node:assert';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFileWithinWorkspace } from '../../../packages/daemon/src/lib/acp/acp-safe-fs-backend.ts';

const run = process.argv.at(-1)!;
mkdirSync(join(run, 'evidence'), { recursive: true });
const fixture = mkdtempSync(join(run, 'safe-files-'));
const root = join(fixture, 'Neo');
const outside = join(fixture, 'outside');
mkdirSync(root);
mkdirSync(outside);
writeFileSync(join(outside, 'doc'), 'Outside sentinel.');
const binary = Buffer.from([0xff, 0xc3, 0x28, 0, 0x42]);
const evidence: Record<string, unknown> = { runtime: Reflect.get(globalThis, 'Deno')?.version?.deno ?? process.versions.bun };
try {
  await replaceFileWithinWorkspace(root, ['nested', 'binary'], binary);
  assert.deepEqual(readFileSync(join(root, 'nested', 'binary')), binary);
  chmodSync(join(root, 'nested', 'binary'), 0o640);
  await replaceFileWithinWorkspace(root, ['nested', 'binary'], binary);
  assert.equal(lstatSync(join(root, 'nested', 'binary')).mode & 0o777, 0o640);
  const large = Buffer.alloc(4 * 1024 * 1024 + 1, 0x41);
  await replaceFileWithinWorkspace(root, ['large'], large);
  assert.deepEqual(readFileSync(join(root, 'large')), large);
  evidence.exactBinary = binary.toString('hex');
  evidence.largeBytes = large.length;
  mkdirSync(join(root, 'parent'));
  writeFileSync(join(root, 'parent', 'doc'), 'Original.');
  const leaf = replaceFileWithinWorkspace(root, ['parent', 'doc'], binary);
  queueMicrotask(() => {
    rmSync(join(root, 'parent', 'doc'));
    symlinkSync(join(outside, 'doc'), join(root, 'parent', 'doc'));
  });
  await leaf;
  assert.equal(readFileSync(join(outside, 'doc'), 'utf8'), 'Outside sentinel.');
  assert.deepEqual(readFileSync(join(root, 'parent', 'doc')), binary);
  chmodSync(join(root, 'parent', 'doc'), 0o640);
  chmodSync(join(outside, 'doc'), 0o666);
  const parentBytes = Buffer.from([0x48, 0xff, 0]);
  const parent = replaceFileWithinWorkspace(root, ['parent', 'doc'], parentBytes);
  queueMicrotask(() => {
    renameSync(join(root, 'parent'), join(root, 'preserved'));
    symlinkSync(outside, join(root, 'parent'));
  });
  await parent;
  assert.equal(readFileSync(join(outside, 'doc'), 'utf8'), 'Outside sentinel.');
  assert.deepEqual(readFileSync(join(root, 'preserved', 'doc')), parentBytes);
  assert.equal(lstatSync(join(root, 'preserved', 'doc')).mode & 0o777, 0o640);
  evidence.parentSwapMode = '0640 preserved despite outside mode 0666';
  await assert.rejects(replaceFileWithinWorkspace(root, ['parent', 'doc'], null));
  assert.equal(readFileSync(join(outside, 'doc'), 'utf8'), 'Outside sentinel.');
  await replaceFileWithinWorkspace(root, ['parent'], null);
  assert.equal(lstatSync(join(root, 'parent'), { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(join(outside, 'doc'), 'utf8'), 'Outside sentinel.');
  mkdirSync(join(root, 'readonly'), { mode: 0o555 });
  await assert.rejects(replaceFileWithinWorkspace(root, ['readonly', 'doc'], binary), { code: 'EACCES' });
  await assert.rejects(replaceFileWithinWorkspace(root, ['x'.repeat(300)], binary), { code: 'ENAMETOOLONG' });
  evidence.leafSwap = 'outside unchanged; home leaf replaced';
  evidence.parentSwap = 'write stayed on pinned directory';
  evidence.parentDeletion = 'refused without outside change';
  evidence.leafDeletion = 'unlinked symlink without following it';
  evidence.errors = ['EACCES', 'ENAMETOOLONG'];
  writeFileSync(join(run, 'evidence', 'neo-home-safe-files.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS: exact binary/unbounded writes and directory-relative write/delete preserve outside bytes through late swaps.');
} finally {
  if (lstatSync(join(root, 'readonly'), { throwIfNoEntry: false })) chmodSync(join(root, 'readonly'), 0o755);
  rmSync(fixture, { recursive: true, force: true });
}
