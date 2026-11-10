import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeCurlFailure,
  describeWriteFailure,
  downloadVerifiedTarball,
  extractFileFromTarGz,
  extractPackageFromTarGz,
  isSafeTarPath,
  mustRestartDownload,
  waitForDownload,
} from '../../../../src/lib/agent/npm-package-download.ts';
import {
  isNetworkUnreachableError,
  networkProbeHost,
} from '../../../../src/lib/agent/network-outage-pause.ts';
import { installFakeCurl, npmTarball } from '../../helpers/npm-tarball.ts';

describe('npm-package-download', () => {
  const originalPath = process.env.PATH;
  let run = '';

  beforeEach(() => {
    run = mkdtempSync(join(tmpdir(), 'npm-package-download-'));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(run, { recursive: true, force: true });
  });

  const writeTarball = (tarball: Buffer) => {
    const path = join(run, 'package.tgz');
    writeFileSync(path, tarball);
    return path;
  };

  it('extractPackageFromTarGz restores nested files, ustar prefixes and executable modes', async () => {
    const tarball = writeTarball(
      npmTarball([
        { path: 'package/bin/tool', body: 'tool', mode: 0o755 },
        { path: 'data.txt', prefix: 'package/deep/folder', body: 'data' },
      ])
    );
    const dest = join(run, 'out');

    await extractPackageFromTarGz(tarball, dest);

    expect(readFileSync(join(dest, 'bin/tool'), 'utf8')).toBe('tool');
    expect(statSync(join(dest, 'bin/tool')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(dest, 'deep/folder/data.txt'), 'utf8')).toBe('data');
  });

  it('extractPackageFromTarGz writes nothing when any path escapes the package', async () => {
    const tarball = writeTarball(
      npmTarball([
        { path: 'package/ok.txt', body: 'ok' },
        { path: 'package/../../escape.txt', body: 'bad' },
      ])
    );
    const dest = join(run, 'nested', 'out');

    await expect(extractPackageFromTarGz(tarball, dest)).rejects.toThrow('unsafe path');

    expect(existsSync(join(dest, 'ok.txt'))).toBe(false);
    expect(existsSync(join(run, 'escape.txt'))).toBe(false);
  });

  it('isSafeTarPath rejects absolute and parent paths', () => {
    expect(isSafeTarPath('prebuilds/runtime.node')).toBe(true);
    expect(isSafeTarPath('/etc/passwd')).toBe(false);
    expect(isSafeTarPath('a/../../b')).toBe(false);
    expect(isSafeTarPath('a\\..\\b')).toBe(false);
  });

  it('extractFileFromTarGz picks one file by package-relative name', async () => {
    const tarball = writeTarball(
      npmTarball([
        { path: 'package/other', body: 'other' },
        { path: 'package/claude', body: 'binary' },
      ])
    );
    const dest = join(run, 'claude');

    await extractFileFromTarGz(tarball, 'claude', dest);

    expect(readFileSync(dest, 'utf8')).toBe('binary');
  });

  it('downloadVerifiedTarball accepts a tarball matching the registry integrity', async () => {
    const curl = installFakeCurl(run, npmTarball([{ path: 'package/a', body: 'a' }]));
    process.env.PATH = curl.path;
    const dest = join(run, 'cache', 'pkg.tgz.partial');

    await downloadVerifiedTarball('pkg', '1.0.0', dest);

    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(curl.log, 'utf8')).toContain('-C -');
  });

  it('downloadVerifiedTarball skips the download when the kept file is already complete', async () => {
    const tarball = npmTarball([{ path: 'package/a', body: 'a' }]);
    const curl = installFakeCurl(run, tarball);
    process.env.PATH = curl.path;
    const dest = join(run, 'pkg.tgz.partial');
    writeFileSync(dest, tarball);

    await downloadVerifiedTarball('pkg', '1.0.0', dest);

    expect(existsSync(curl.log)).toBe(false);
  });

  it('downloadVerifiedTarball drops a file that fails the integrity check', async () => {
    const tarball = npmTarball([{ path: 'package/a', body: 'a' }]);
    process.env.PATH = installFakeCurl(run, tarball, 'sha512-no').path;
    const dest = join(run, 'out.tgz');

    await expect(downloadVerifiedTarball('pkg', '1.0.0', dest)).rejects.toThrow(
      'integrity mismatch for pkg@1.0.0'
    );

    expect(existsSync(dest)).toBe(false);
  });

  it('downloadVerifiedTarball keeps the partial file and names the failure', async () => {
    const tarball = npmTarball([{ path: 'package/a', body: 'a' }]);
    process.env.PATH = installFakeCurl(run, tarball, undefined, 18).path;
    const dest = join(run, 'out.tgz');

    await expect(downloadVerifiedTarball('pkg', '1.0.0', dest)).rejects.toThrow('cannot reach npm');

    expect(existsSync(dest)).toBe(true);
  });

  it('downloadVerifiedTarball reports a missing curl', async () => {
    process.env.PATH = run;

    await expect(downloadVerifiedTarball('pkg', '1.0.0', join(run, 'out.tgz'))).rejects.toThrow(
      'curl is not installed'
    );
  });

  it('describeCurlFailure names network failures so the outage hold can probe them', () => {
    for (const code of [6, 7, 18, 28, 35, 52, 56]) {
      const text = describeCurlFailure({ code, stderr: 'curl: failed' }, 'registry.npmjs.org');
      expect(text).toContain('cannot reach npm');
      expect(text).toContain('curl: failed');
      expect(isNetworkUnreachableError(text)).toBe(true);
      expect(networkProbeHost(text)).toBe('registry.npmjs.org');
    }
  });

  it('describeCurlFailure separates local failures from network failures', () => {
    const host = 'registry.npmjs.org';
    const disk = describeCurlFailure({ code: 23, stderr: 'curl: (23) write' }, host);
    const http = describeCurlFailure({ code: 22, stderr: 'curl: (22) 403' }, host);
    const missing = describeCurlFailure({ code: 'ENOENT', stderr: '' }, host);

    expect(disk).toContain('disk full');
    expect(http).toContain('npm request failed: curl: (22) 403');
    expect(missing).toBe('curl is not installed or not on PATH');
    for (const text of [disk, http, missing]) expect(isNetworkUnreachableError(text)).toBe(false);
  });

  it('describeWriteFailure names a full disk', () => {
    const full = Object.assign(new Error('no space'), { code: 'ENOSPC' });

    expect(describeWriteFailure(full)).toBe('disk full: no space');
    expect(describeWriteFailure(new Error('other'))).toBe('other');
  });

  it('mustRestartDownload restarts only when the server cannot continue the file', () => {
    expect(mustRestartDownload({ code: 33, stderr: '' })).toBe(true);
    expect(mustRestartDownload({ code: 22, stderr: 'returned error: 416' })).toBe(true);
    expect(mustRestartDownload({ code: 22, stderr: 'returned error: 403' })).toBe(false);
    expect(mustRestartDownload({ code: 18, stderr: '' })).toBe(false);
  });

  it('waitForDownload hands a slow download to the outage hold', async () => {
    const pending = new Promise<string>(() => {});

    const text = await waitForDownload(pending, 1, 'Claude Code binary').catch(String);

    expect(text).toContain('Claude Code binary is still downloading');
    expect(isNetworkUnreachableError(text)).toBe(true);
    expect(networkProbeHost(text)).toBe('registry.npmjs.org');
  });

  it('waitForDownload returns a finished download', async () => {
    expect(await waitForDownload(Promise.resolve('path'), 1000, 'Copilot runtime')).toBe('path');
  });
});
