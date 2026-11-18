import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installOxapHub,
  OXAP_VERSION,
  publishedSum,
  releaseName,
} from '../../../../src/lib/oxap/oxap-install';

const roots: string[] = [];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const name = `oxap-${OXAP_VERSION}-macos-arm64`;
const base = `https://github.com/lsm/oxap/releases/download/v${OXAP_VERSION}`;

function release(sums?: (archiveSum: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'oxap-install-'));
  roots.push(root);
  writeFileSync(join(root, 'oxap'), '#!/bin/sh\necho synthetic\n');
  writeFileSync(join(root, 'oapx'), 'alias');
  execFileSync('tar', ['-czf', join(root, 'release.tar.gz'), '-C', root, 'oxap', 'oapx']);
  const archive = readFileSync(join(root, 'release.tar.gz'));
  const text = sums
    ? sums(sha(archive))
    : `${'1'.repeat(64)}  oxap-${OXAP_VERSION}-linux-x64.tar.gz\n${sha(archive)}  ${name}.tar.gz\n`;
  const requested: string[] = [];
  const fetcher = (async (url: string) => {
    requested.push(url);
    if (url === `${base}/SHA256SUMS.txt`) return new Response(text);
    if (url === `${base}/${name}.tar.gz`) return new Response(archive);
    return new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
  return { root, fetcher, requested, binary: readFileSync(join(root, 'oxap')) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('releaseName', () => {
  it('names the release asset for this platform and refuses one without a release', () => {
    expect(releaseName('darwin', 'arm64')).toBe(name);
    expect(releaseName('linux', 'x64')).toBe(`oxap-${OXAP_VERSION}-linux-x64`);
    expect(() => releaseName('win32', 'x64')).toThrow('no release');
  });
});

describe('publishedSum', () => {
  it('reads the entry for exactly this asset from SHA256SUMS.txt', () => {
    const sums = `${'a'.repeat(64)}  ${name}.tar.gz.sig\n${'b'.repeat(64)} *${name}.tar.gz\n`;
    expect(publishedSum(sums, `${name}.tar.gz`)).toBe('b'.repeat(64));
    expect(() => publishedSum(sums, 'other.tar.gz')).toThrow('no entry');
  });

  it('reads a SHA256SUMS.txt with CRLF line endings', () => {
    const sums = `${'a'.repeat(64)}  other.tar.gz\r\n${'b'.repeat(64)}  ${name}.tar.gz\r\n`;
    expect(publishedSum(sums, `${name}.tar.gz`)).toBe('b'.repeat(64));
  });
});

describe('installOxapHub', () => {
  it('installs the pinned binary only after its archive matches the published checksum', async () => {
    const host = release();
    const target = join(host.root, 'install');
    const installed = await installOxapHub(target, undefined, host.fetcher, name);
    expect(installed).toEqual({
      path: join(target, name, 'oxap'),
      version: name,
      sha256: sha(host.binary),
    });
    expect(readFileSync(installed.path, 'utf8')).toBe('#!/bin/sh\necho synthetic\n');
    expect(host.requested).toEqual([`${base}/SHA256SUMS.txt`, `${base}/${name}.tar.gz`]);
  });

  it('refuses an archive that does not match SHA256SUMS.txt and installs nothing', async () => {
    const host = release(() => `${'0'.repeat(64)}  ${name}.tar.gz\n`);
    const target = join(host.root, 'install');
    await expect(installOxapHub(target, undefined, host.fetcher, name)).rejects.toThrow(
      "does not match the release's SHA256SUMS.txt"
    );
    expect(existsSync(join(target, name, 'oxap'))).toBe(false);
  });

  it('bounds every download with a timeout signal', async () => {
    const host = release();
    const signals: unknown[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return host.fetcher(url);
    }) as unknown as typeof fetch;
    await installOxapHub(join(host.root, 'install'), undefined, fetcher, name);
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a download larger than its limit, by header or by body, and installs nothing', async () => {
    const host = release();
    const target = join(host.root, 'install');
    const declared = (async () =>
      new Response('x', {
        headers: { 'content-length': String(1024 * 1024) },
      })) as unknown as typeof fetch;
    await expect(installOxapHub(target, undefined, declared, name)).rejects.toThrow('larger than');
    const streamed = (async () =>
      new Response(new Uint8Array(65 * 1024))) as unknown as typeof fetch;
    await expect(installOxapHub(target, undefined, streamed, name)).rejects.toThrow('larger than');
    expect(existsSync(join(target, name, 'oxap'))).toBe(false);
  });

  it('keeps an intact installed binary without downloading again', async () => {
    const host = release();
    const target = join(host.root, 'install');
    const first = await installOxapHub(target, undefined, host.fetcher, name);
    host.requested.length = 0;
    expect(await installOxapHub(target, first, host.fetcher, name)).toEqual(first);
    expect(host.requested).toEqual([]);
    writeFileSync(first.path, 'tampered');
    expect(await installOxapHub(target, first, host.fetcher, name)).toEqual(first);
    expect(host.requested).toHaveLength(2);
  });
});
