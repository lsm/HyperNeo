import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  embeddingRuntime,
  fetchEmbeddingAsset,
} from '../../../src/storage/repositories/embedding-assets.ts';

const originalFetch = globalThis.fetch;
const directories: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('verified embedding assets', () => {
  test('fetches a missing asset, verifies its checksum and reuses verified bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'embedding-asset-'));
    directories.push(root);
    const file = join(root, 'model.onnx');
    const body = 'synthetic embedding model';
    const checksum = 'sha256:' + createHash('sha256').update(body).digest('hex');
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response(body);
    }) as typeof fetch;
    await fetchEmbeddingAsset(file, 'https://assets.invalid/model', checksum);
    expect(await readFile(file, 'utf8')).toBe(body);
    await fetchEmbeddingAsset(file, 'https://assets.invalid/model', checksum);
    expect(requests).toBe(1);
    await writeFile(file, 'damaged');
    await fetchEmbeddingAsset(file, 'https://assets.invalid/model', checksum);
    expect(await readFile(file, 'utf8')).toBe(body);
    expect(requests).toBe(2);
  });

  test('refuses checksum-mismatched downloads without publishing or retaining partial files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'embedding-checksum-'));
    directories.push(root);
    const file = join(root, 'runtime.tgz');
    const checksum = 'sha512:' + createHash('sha512').update('approved runtime').digest('base64');
    globalThis.fetch = (async () => new Response('tampered runtime')) as typeof fetch;
    await expect(
      fetchEmbeddingAsset(file, 'https://assets.invalid/runtime', checksum)
    ).rejects.toThrow('Checksum mismatch');
    await expect(readFile(file)).rejects.toThrow();
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(root)).toEqual([]);
  });

  test('reports an unsupported platform before making any network request', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('unexpected');
    }) as typeof fetch;
    await expect(embeddingRuntime('/unused', 'freebsd', 'x64')).rejects.toThrow(
      'Unsupported embedding platform: freebsd/x64'
    );
    expect(requests).toBe(0);
  });
});
