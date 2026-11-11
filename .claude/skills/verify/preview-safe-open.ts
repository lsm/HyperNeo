import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, fstatSync, linkSync, mkdirSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withArtifactDescriptor } from '../../../packages/daemon/src/lib/runtime-artifact-open.ts';

const root = realpathSync(resolve(process.argv[2] ?? ''));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
const workspace = join(root, 'workspace');
const outside = join(root, 'outside');
mkdirSync(join(workspace, 'nested'), { recursive: true });
mkdirSync(outside);
const bytes = Buffer.from([0, 255, 10, 32, 240, 159, 166, 138]);
writeFileSync(join(workspace, 'nested', 'report.bin'), bytes);
writeFileSync(join(outside, 'report.bin'), 'SYNTHETIC OUTSIDE SENTINEL');
execFileSync('mkfifo', [join(workspace, 'pipe')]);
const read = (fd: number) => {
  const buffer = Buffer.alloc(128);
  return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
};
const descriptorDirectory = process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd';
let capturedFd = -1;
const first = await withArtifactDescriptor(workspace, ['nested', 'report.bin'], (fd, initial) => {
  capturedFd = fd;
  assert(initial.isFile() && initial.nlink === 1 && initial.size === bytes.length);
  return read(fd);
});
assert(first.accepted && first.value.equals(bytes));
assert.throws(() => fstatSync(capturedFd));
const before = readdirSync(descriptorDirectory).length;
const denied = async (root: string, segments: string[]) => {
  const result = await withArtifactDescriptor(root, segments, () => { throw new Error('unsafe consumer'); });
  assert.deepEqual(result, { accepted: false, reason: 'unsafe_path' });
};
symlinkSync(join(outside, 'report.bin'), join(workspace, 'final-link'));
symlinkSync(outside, join(workspace, 'parent-link'));
symlinkSync(workspace, join(root, 'root-link'));
await denied(workspace, ['final-link']);
await denied(workspace, ['parent-link', 'report.bin']);
await denied(join(root, 'root-link'), ['nested', 'report.bin']);
await denied(join(root, 'root-link', 'nested'), ['report.bin']);
linkSync(join(outside, 'report.bin'), join(workspace, 'hardlink'));
await denied(workspace, ['hardlink']);
await denied(workspace, ['nested']);
await denied(workspace, ['pipe']);
for (const segments of [[], ['..', 'outside', 'report.bin'], ['nested/report.bin'], ['nested', 'report.bin\0ignored']]) await denied(workspace, segments);
await denied(workspace, ['missing', 'report.bin']);
await assert.rejects(withArtifactDescriptor(workspace, ['nested', 'report.bin'], () => { throw new Error('synthetic consumer failure'); }), /synthetic consumer failure/);
for (let count = 0; count < 50; count++) {
  const result = await withArtifactDescriptor(workspace, ['nested', 'report.bin'], read);
  assert(result.accepted && result.value.equals(bytes));
}
assert.equal(readdirSync(descriptorDirectory).length, before);
const originalParent = join(workspace, 'nested');
const stable = await withArtifactDescriptor(workspace, ['nested', 'report.bin'], (fd) => {
  renameSync(originalParent, join(workspace, 'retained-parent'));
  symlinkSync(outside, originalParent);
  return read(fd);
});
assert(stable.accepted && stable.value.equals(bytes));
await denied(workspace, ['nested', 'report.bin']);
mkdirSync(join(workspace, 'racing'));
writeFileSync(join(workspace, 'racing', 'report.bin'), bytes);
const childCode = `
const fs = require('node:fs');
const p = ${JSON.stringify(workspace)};
const outside = ${JSON.stringify(outside)};
let swaps = 0;
fs.writeFileSync(p + '/ready', 'ready');
while (!fs.existsSync(p + '/stop')) {
  fs.renameSync(p + '/racing', p + '/parked');
  fs.symlinkSync(outside, p + '/racing');
  await Bun.sleep(1);
  fs.unlinkSync(p + '/racing');
  fs.renameSync(p + '/parked', p + '/racing');
  swaps++;
  await Bun.sleep(1);
}
fs.writeFileSync(p + '/swaps', String(swaps));
`;
const child = Bun.spawn([process.execPath, '-e', childCode], {
  cwd: root, env: { HOME: join(root, 'home'), NODE_ENV: 'test', PATH: process.env.PATH }, stdout: 'ignore', stderr: 'pipe',
});
let successes = 0;
let refusals = 0;
try {
  for (let count = 0; !existsSync(join(workspace, 'ready')); count++) {
    assert(count < 500, 'race process failed to start');
    await Bun.sleep(10);
  }
  for (let attempt = 0; attempt < 1000; attempt++) {
    const result = await withArtifactDescriptor(workspace, ['racing', 'report.bin'], read);
    if (result.accepted) { assert(result.value.equals(bytes)); successes++; }
    else { assert.equal(result.reason, 'unsafe_path'); refusals++; }
    if (attempt % 20 === 0) await Bun.sleep(1);
  }
} finally {
  writeFileSync(join(workspace, 'stop'), 'stop');
  const timer = setTimeout(() => child.kill(), 5000);
  try { assert.equal(await child.exited, 0, await new Response(child.stderr).text()); }
  finally { clearTimeout(timer); }
}
assert(Number(readFileSync(join(workspace, 'swaps'), 'utf8')) > 0);
assert(successes > 0 && refusals > 0);
const afterRace = readdirSync(descriptorDirectory).length;
for (let count = 0; count < 50; count++) await denied(workspace, ['final-link']);
assert.equal(readdirSync(descriptorDirectory).length, afterRace);
const evidence = { exactBytes: true, symlinksDenied: true, hardlinksDenied: true,
  descriptorStable: true, parentRaceContained: true, descriptorsClosed: true,
  platform: process.platform, runtime: process.versions.bun, successes, refusals,
};
writeFileSync(join(root, 'safe-open-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
