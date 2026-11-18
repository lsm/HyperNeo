import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerifiedTarball } from '../../../../src/lib/agent/npm-package-download.ts';
import { integrityOf, npmTarball } from '../../helpers/npm-tarball.ts';

describe('configured package downloads', () => {
  const originalPath = process.env.PATH;
  let run = '';
  const script = (name: string, body: string) => {
    const path = join(run, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };

  beforeEach(() => {
    run = mkdtempSync(join(tmpdir(), 'registry-config-'));
    process.env.PATH = run;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(run, { recursive: true, force: true });
  });

  it('uses npm pack when npm is available', async () => {
    const archive = npmTarball([{ path: 'package/claude', body: 'binary' }]);
    writeFileSync(join(run, 'fixture.tgz'), archive);
    script(
      'npm',
      `printf '%s\\n' "$@" > '${run}/args'; /bin/cp '${run}/fixture.tgz' "$4/pkg.tgz"; printf '%s\\n' "$4/pkg.tgz"`
    );
    const dest = join(run, 'result.tgz');
    await downloadVerifiedTarball('@example/pkg', '1.2.3', dest);
    expect(readFileSync(dest).toString('base64')).toBe(archive.toString('base64'));
    expect(readFileSync(join(run, 'args'), 'utf8')).toContain(
      '@example/pkg@1.2.3\n--pack-destination\n'
    );
  });

  it('reports an npm failure without using fallback or exposing stderr', async () => {
    script('npm', "printf 'private-token-example' >&2; exit 7");
    script('pnpm', `printf 'called' > '${run}/pnpm-called'`);
    script('curl', `printf 'called' > '${run}/curl-called'`);
    try {
      await downloadVerifiedTarball('pkg', '1.0.0', join(run, 'result.tgz'));
      throw new Error('expected failure');
    } catch (error) {
      expect((error as Error).message).toBe(
        'npm could not download the package (exit 7); check your npm registry and login'
      );
      expect(String(error)).not.toContain('private-token-example');
    }
    expect(existsSync(join(run, 'pnpm-called'))).toBe(false);
    expect(existsSync(join(run, 'curl-called'))).toBe(false);
  });

  it('uses the pnpm registry when npm is absent', async () => {
    const archive = npmTarball([{ path: 'package/claude', body: 'binary' }]);
    writeFileSync(join(run, 'fixture.tgz'), archive);
    script('pnpm', "printf 'https://mirror.example.test\\n'");
    script(
      'curl',
      `case "$*" in *-fL*) while [ "$1" != '-o' ]; do shift; done; /bin/cp '${run}/fixture.tgz' "$2";; *) printf '%s' "$*" > '${run}/url'; printf '%s' '{"dist":{"tarball":"https://mirror.example.test/pkg.tgz","integrity":"${integrityOf(archive)}"}}';; esac`
    );
    const dest = join(run, 'result.tgz');
    await downloadVerifiedTarball('@example/pkg', '1.2.3', dest);
    expect(readFileSync(dest).toString('base64')).toBe(archive.toString('base64'));
    expect(readFileSync(join(run, 'url'), 'utf8')).toContain('https://mirror.example.test/');
  });

  it('reports a registry web page in plain language', async () => {
    script('curl', "printf '<html>blocked</html>'");
    await expect(downloadVerifiedTarball('pkg', '1.0.0', join(run, 'result.tgz'))).rejects.toThrow(
      'registry returned a web page, not package metadata (blocked by the network?)'
    );
  });
});
