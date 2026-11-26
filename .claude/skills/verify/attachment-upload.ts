import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';

const run = resolve(process.argv.at(-1)!);
const data = join(run, 'data');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
assert(
  ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN'].every(
    (name) => process.env[name] === undefined
  )
);

const staging = join(data, 'staged-attachments');
await mkdir(staging, { recursive: true });
await mkdir(join(run, 'evidence'));
await writeFile(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
  'base64'
);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = sha256(png);
const expired = sha256(Buffer.concat([png, Buffer.from([1])]));
const recentBytes = Buffer.concat([png, Buffer.from([3])]);
const recent = sha256(recentBytes);
const abandoned = '11111111-1111-4111-8111-111111111111.part';
const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
for (const name of [expired, abandoned]) {
  const path = join(staging, name);
  await writeFile(path, png);
  await utimes(path, old, old);
}
await writeFile(join(staging, recent), recentBytes);

const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(data, 'daemon.db'), workspaceRoot: run }),
    disableWorktrees: true,
  },
  verbose: false,
});
assert(![8399, 8499].includes(app.server.port));
const base = `http://127.0.0.1:${app.server.port}`;
const endpoint = (sha: string) => `${base}/api/attachments/${sha}`;
const receipt: Record<string, unknown> = { head: process.argv[2] };

async function status(response: Response) {
  await response.arrayBuffer();
  return response.status;
}

try {
  assert.deepEqual(await readdir(staging), [recent]);
  receipt.expiredFileAndAbandonedTempRemoved = true;

  assert.equal(await status(await fetch(endpoint(hash), { method: 'PUT', body: png })), 401);
  const pairing = new DevicePairingRepository(app.db.getDatabase());
  const { code } = pairing.createCode('human', 'Synthetic phone', true, Date.now());
  const paired = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Synthetic phone' }),
  });
  assert.equal(paired.status, 200);
  const { credential } = (await paired.json()) as { credential: string };
  assert(credential);
  const headers = { authorization: `Bearer ${credential}`, 'content-type': 'image/png' };
  const put = (sha: string, body = png, extra: Record<string, string> = {}) =>
    fetch(endpoint(sha), {
      method: 'PUT',
      headers: { ...headers, ...extra },
      body,
      signal: AbortSignal.timeout(10_000),
    }).then(status);
  const chunked = (sha: string, bytes: Buffer, end: boolean) =>
    new Promise<number>((resolveStatus, reject) => {
      const upload = request(
        endpoint(sha),
        { method: 'PUT', headers: { ...headers, 'transfer-encoding': 'chunked' } },
        (response) => {
          response.resume();
          response.once('end', () => {
            resolveStatus(response.statusCode ?? 0);
            upload.destroy();
          });
          response.once('error', reject);
        }
      );
      upload.once('error', reject);
      upload.setTimeout(8_000, () => upload.destroy(new Error('Timed out waiting for upload response')));
      upload.write(bytes.subarray(0, 3));
      upload.write(bytes.subarray(3));
      if (end) upload.end();
    });

  assert.equal(await put(hash, png, { origin: 'https://cross-site.invalid' }), 403);
  receipt.authentication = { anonymous: 401, crossSite: 403 };

  const wrong = Buffer.concat([png, Buffer.from([2])]);
  assert.equal(await chunked(hash, wrong, true), 422);
  assert.equal(await put(sha256(wrong), wrong, { 'content-type': 'image/jpeg' }), 415);
  assert.equal(await put('invalid-hash'), 400);
  receipt.validation = { hashMismatch: 422, signatureMismatch: 415, invalidHash: 400 };

  const overLimit = Buffer.alloc(3.75 * 1024 * 1024 + 1);
  png.copy(overLimit);
  const streamedStatus = await chunked(sha256(overLimit), overLimit, false);
  assert.equal(streamedStatus, 413);
  assert.deepEqual(await readdir(staging), [recent]);
  receipt.streamingOverLimitBeforeEof = 413;

  const staged = join(staging, hash);
  assert.equal(await chunked(hash, png, true), 204);
  assert.deepEqual(await readFile(staged), png);
  await utimes(staged, old, old);
  assert.equal(await chunked(hash.toUpperCase(), png, true), 204);
  assert((await stat(staged)).mtimeMs > Number(old));
  const concurrent = await Promise.all([put(hash), put(hash)]);
  assert.deepEqual(concurrent, [204, 204]);
  assert.deepEqual((await readdir(staging)).sort(), [hash, recent].sort());
  assert.deepEqual(await readFile(staged), png);
  receipt.duplicatePut = { published: 204, repeated: 204, concurrent, refreshed: true };
  receipt.passed = true;
} finally {
  await app.cleanup();
  await writeFile(join(run, 'evidence/attachment-upload.json'), JSON.stringify(receipt, null, 2));
}
