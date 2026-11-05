import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadVerifiedTarball,
  extractFileFromTarGz,
  extractPackageFromTarGz,
  isSafeTarPath,
} from '../../../../src/lib/agent/npm-package-download.ts';
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

    expect(await extractPackageFromTarGz(tarball, dest)).toBe(true);

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

    expect(await extractPackageFromTarGz(tarball, dest)).toBe(false);

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

    expect(await extractFileFromTarGz(tarball, 'claude', dest)).toBe(dest);

    expect(readFileSync(dest, 'utf8')).toBe('binary');
  });

  it('downloadVerifiedTarball accepts a tarball matching the registry integrity', async () => {
    const curl = installFakeCurl(run, npmTarball([{ path: 'package/a', body: 'a' }]));
    process.env.PATH = curl.path;

    expect(await downloadVerifiedTarball('pkg', '1.0.0', join(run, 'out.tgz'))).toBe(true);
  });

  it('downloadVerifiedTarball refuses a tarball that fails the integrity check', async () => {
    const curl = installFakeCurl(run, npmTarball([{ path: 'package/a', body: 'a' }]), 'sha512-no');
    process.env.PATH = curl.path;

    expect(await downloadVerifiedTarball('pkg', '1.0.0', join(run, 'out.tgz'))).toBe(false);
  });
});
