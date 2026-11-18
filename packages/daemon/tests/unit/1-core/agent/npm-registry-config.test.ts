import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      `printf '%s\\n' "$@" > '${run}/args'; /bin/cp '${run}/fixture.tgz' "$4/pkg.tgz"; printf 'pkg.tgz\\n'`
    );
    const dest = join(run, 'result.tgz');
    await downloadVerifiedTarball('@example/pkg', '1.2.3', dest);
    expect(readFileSync(dest)).toEqual(archive);
    expect(readFileSync(join(run, 'args'), 'utf8')).toContain(
      '@example/pkg@1.2.3\n--pack-destination\n'
    );
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
    expect(readFileSync(dest)).toEqual(archive);
    expect(readFileSync(join(run, 'url'), 'utf8')).toContain('https://mirror.example.test/');
  });

  it('reports a registry web page in plain language', async () => {
    script('curl', "printf '<html>blocked</html>'");
    await expect(downloadVerifiedTarball('pkg', '1.0.0', join(run, 'result.tgz'))).rejects.toThrow(
      'registry returned a web page, not package metadata (blocked by the network?)'
    );
  });
});
