import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spyOn } from 'bun:test';
import { createArtifactCaptureStore } from '../../../packages/daemon/src/lib/artifacts/capture-store.ts';

const root = realpathSync(resolve(process.argv[2] ?? ''));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
if (process.argv[3] === 'crash') {
  const source = join(root, 'crash-source');
  mkdirSync(source);
  writeFileSync(join(source, 'partial.bin'), Buffer.alloc(800000, 91));
  const store = await createArtifactCaptureStore(join(root, 'artifacts'));
  const original = fs.open;
  spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]).includes('/staging/')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...chunks) => {
        await write(...chunks);
        await handle.sync();
        writeFileSync(join(root, 'crash-ready'), 'partial bytes synced');
        await Bun.sleep(30000);
        throw new Error('owner did not interrupt the test process');
      };
    }
    return handle;
  });
  await store.capture(source, ['partial.bin']);
  throw new Error('crash fixture unexpectedly committed');
}
const source = join(root, 'workspace');
mkdirSync(source);
const bytes = Buffer.concat([Buffer.from('  Synthetic report 🦊\n'.repeat(24000)), Buffer.from([0, 255, 10])]);
writeFileSync(join(source, 'report.bin'), bytes);
const hash = createHash('sha256').update(bytes).digest('hex');
const directory = join(root, 'artifacts');
const store = await createArtifactCaptureStore(directory);
const receipt = await store.capture(source, ['report.bin']);
assert.deepEqual(receipt, { accepted: true, sha256: hash, byteLength: bytes.length });
const blob = join(directory, 'blobs', hash);
assert(readFileSync(blob).equals(bytes));
assert(readFileSync(join(source, 'report.bin')).equals(bytes));
assert.equal(statSync(blob).mode & 0o222, 0);
writeFileSync(join(root, 'outside.bin'), 'SYNTHETIC OUTSIDE SENTINEL');
symlinkSync(join(root, 'outside.bin'), join(source, 'outside-link'));
assert.deepEqual(await store.capture(source, ['outside-link']), { accepted: false, reason: 'unsafe_path' });
const inode = statSync(blob).ino;
assert.deepEqual(await store.capture(source, ['report.bin']), receipt);
assert.equal(statSync(blob).ino, inode);
assert.equal((await store.inspect()).retainedBytes, bytes.length);
assert.equal((await store.inspect()).entries.filter((entry) => entry.area === 'staging').length, 0);
writeFileSync(join(source, 'empty.bin'), Buffer.alloc(0));
assert.deepEqual(await store.capture(source, ['empty.bin']), { accepted: true, sha256: createHash('sha256').digest('hex'), byteLength: 0 });
const quota = await createArtifactCaptureStore(join(root, 'quota'), { artifactBytes: bytes.length, retainedBytes: bytes.length + 1 });
writeFileSync(join(source, 'second.bin'), Buffer.alloc(bytes.length, 33));
const parallel = await Promise.all([quota.capture(source, ['report.bin']), quota.capture(source, ['second.bin'])]);
assert.equal(parallel.filter((value) => value.accepted).length, 1);
assert.equal(parallel.filter((value) => !value.accepted && value.reason === 'quota_full').length, 1);
assert.equal((await quota.inspect()).reservedBytes, 0);
assert.equal((await quota.inspect()).retainedBytes, bytes.length);
assert.equal((await quota.inspect()).warning, true);
const limited = await createArtifactCaptureStore(join(root, 'limited'), { artifactBytes: 1 });
assert.deepEqual(await limited.capture(source, ['report.bin']), { accepted: false, reason: 'size_limit', actualBytes: bytes.length, limitBytes: 1 });
assert.equal((await limited.inspect()).entries.length, 0);
const concurrent = await createArtifactCaptureStore(join(root, 'concurrent'));
const originalUnlink = fs.unlink;
const delayed = spyOn(fs, 'unlink').mockImplementation(async (path) => { await Bun.sleep(30); return originalUnlink(path); });
let identical;
try { identical = await Promise.allSettled([concurrent.capture(source, ['report.bin']), concurrent.capture(source, ['report.bin'])]); }
finally { delayed.mockRestore(); }
assert(identical.every((result) => result.status === 'fulfilled' && result.value.accepted), 'concurrent identical captures must deduplicate');
assert.equal((await concurrent.inspect()).retainedBytes, bytes.length);

const corruptDirectory = join(root, 'corrupt');
const corrupt = await createArtifactCaptureStore(corruptDirectory);
assert((await corrupt.capture(source, ['report.bin'])).accepted);
const corruptBlob = join(corruptDirectory, 'blobs', hash);
chmodSync(corruptBlob, 0o600);
const tampered = Buffer.alloc(bytes.length, 2);
writeFileSync(corruptBlob, tampered);
await assert.rejects(corrupt.capture(source, ['report.bin']), /artifact_blob_conflict/);
assert(readFileSync(corruptBlob).equals(tampered));
const originalOpen = fs.open;
const faultStore = await createArtifactCaptureStore(join(root, 'faults'));
assert((await faultStore.capture(source, ['report.bin'])).accepted);
let changed = false;
const mutate = spyOn(fs, 'open').mockImplementation(async (...args) => {
  const handle = await originalOpen(...args);
  if (String(args[0]).includes('/staging/')) {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...chunks) => {
      await write(...chunks);
      if (!changed) { changed = true; await fs.writeFile(join(source, 'report.bin'), 'changed during capture'); }
    };
  }
  return handle;
});
try { assert.deepEqual(await faultStore.capture(source, ['report.bin']), { accepted: false, reason: 'source_changed' }); }
finally { mutate.mockRestore(); }
assert(readFileSync(join(root, 'faults', 'blobs', hash)).equals(bytes));
const pending = await faultStore.inspect();
assert(pending.entries.some((entry) => entry.area === 'staging' && entry.byteLength > 0));
writeFileSync(join(source, 'report.bin'), bytes);
const diskFull = spyOn(fs, 'open').mockImplementation(async (...args) => {
  const handle = await originalOpen(...args);
  if (String(args[0]).includes('/staging/')) {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...chunks) => {
      await write(...chunks);
      throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
    };
  }
  return handle;
});
try { await assert.rejects(faultStore.capture(source, ['report.bin']), /synthetic disk full/); }
finally { diskFull.mockRestore(); }
const afterFault = await faultStore.inspect();
assert.equal(afterFault.reservedBytes, 0);
assert(afterFault.entries.filter((entry) => entry.area === 'staging').length >= 2);
assert(readFileSync(join(root, 'faults', 'blobs', hash)).equals(bytes));
const reopened = await createArtifactCaptureStore(join(root, 'faults'));
assert.equal((await reopened.inspect()).retainedBytes, afterFault.retainedBytes);
assert.deepEqual((await reopened.inspect()).entries, afterFault.entries);
const crashRoot = join(root, 'crash');
mkdirSync(join(crashRoot, 'home'), { recursive: true });
const beforeCrash = await createArtifactCaptureStore(join(crashRoot, 'artifacts'));
assert((await beforeCrash.capture(source, ['report.bin'])).accepted);
const child = Bun.spawn([process.execPath, resolve(import.meta.path), crashRoot, 'crash'], {
  cwd: root, env: { PATH: process.env.PATH, HOME: join(crashRoot, 'home'), NODE_ENV: 'test' }, stdout: 'ignore', stderr: 'pipe',
});
try {
  for (let count = 0; !existsSync(join(crashRoot, 'crash-ready')); count++) {
    assert(count < 500, 'crash fixture did not reach its durable staging point');
    await Bun.sleep(10);
  }
  child.kill('SIGKILL');
  assert.notEqual(await child.exited, 0);
} finally {
  if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
}
const linkedBytes = Buffer.from('Synthetic completed uncommitted blob');
const linkedHash = createHash('sha256').update(linkedBytes).digest('hex');
const linkedStage = join(crashRoot, 'artifacts', 'staging', 'interrupted-link-fixture');
writeFileSync(linkedStage, linkedBytes);
await fs.link(linkedStage, join(crashRoot, 'artifacts', 'blobs', linkedHash));
const recovered = await createArtifactCaptureStore(join(crashRoot, 'artifacts'));
const recoveredState = await recovered.inspect();
assert(recoveredState.entries.some((entry) => entry.area === 'staging' && entry.byteLength === 256 * 1024));
assert.equal(recoveredState.retainedBytes, bytes.length + 256 * 1024 + linkedBytes.length);
assert(readFileSync(join(crashRoot, 'artifacts', 'blobs', hash)).equals(bytes));
const recoveredQuota = await createArtifactCaptureStore(join(crashRoot, 'artifacts'), { retainedBytes: recoveredState.retainedBytes + 1 });
assert.deepEqual(await recoveredQuota.capture(source, ['report.bin']), { accepted: false, reason: 'quota_full' });
renameSync(source, `${source}.retained-fixture`);
assert(readFileSync(blob).equals(bytes));
const evidence = { exactBytes: true, deduplicated: true, quotaReserved: true, sourceChangeRefused: true,
  interruptionsRetained: true, restartPreserved: true, byteLength: bytes.length, sha256: hash,
  actualProcessCrash: true, sharedInodeCountedOnce: true, recovery: recoveredState, priorFaults: await reopened.inspect() };
writeFileSync(join(root, 'capture-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
