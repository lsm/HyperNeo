import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerifiedTarball } from '../../../../src/lib/agent/npm-package-download.ts';
import { isNetworkUnreachableError } from '../../../../src/lib/agent/network-outage-pause.ts';

describe('downloadVerifiedTarball', () => {
  const originalPath = process.env.PATH;
  let run = '';

  beforeEach(() => {
    run = mkdtempSync(join(tmpdir(), 'download-failure-'));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(run, { recursive: true, force: true });
  });

  for (const [failure, response] of [
    ['a registry block page', "printf '<html>blocked</html>'"],
    ['a failed connection', "echo 'private-token-example' >&2; exit 7"],
  ]) {
    it(`reports ${failure} as a package download failure`, async () => {
      writeFileSync(join(run, 'curl'), `#!/bin/sh\n${response}\n`, { mode: 0o755 });
      process.env.PATH = run;
      const error = await downloadVerifiedTarball('fixture', '1.0.0', join(run, 'out.tgz')).then(
        () => null,
        (err: Error) => err
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.name).toBe('PackageDownloadError');
      expect(error?.message).not.toMatch(/JSON|parse|private-token-example/i);
      expect(isNetworkUnreachableError(error?.message ?? '')).toBe(false);
    });
  }
});
