import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOapBinary, decideBinaryCheck } from '../../../../src/lib/oap/oap-binary';

const expected = { version: '0.1.0', sha256: 'a'.repeat(64) };

describe('decideBinaryCheck', () => {
  test('rejects an incorrect version or SHA256', () => {
    expect(decideBinaryCheck(expected, { version: '0.2.0', sha256: expected.sha256 })).toEqual({
      ok: false,
      reason: 'version_mismatch',
    });
    expect(
      decideBinaryCheck(expected, { version: expected.version, sha256: 'b'.repeat(64) })
    ).toEqual({ ok: false, reason: 'sha256_mismatch' });
  });
});

describe('checkOapBinary', () => {
  test('checks an explicit executable without downloading and invokes --version once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oap-binary-'));
    try {
      const path = join(dir, 'oapx');
      const count = join(dir, 'calls');
      const script = `#!/bin/sh\nprintf '%s\\n' "$1" >> "${count}"\nprintf '0.1.0\\n'\n`;
      await writeFile(path, script);
      await chmod(path, 0o700);
      const sha256 = createHash('sha256').update(script).digest('hex');
      expect(await checkOapBinary(path, { version: '0.1.0', sha256 })).toEqual({ ok: true });
      expect(await readFile(count, 'utf8')).toBe('--version\n');
      expect(await checkOapBinary(path, { version: 'wrong', sha256 })).toEqual({
        ok: false,
        reason: 'version_mismatch',
      });
      expect(await checkOapBinary(path, { version: '0.1.0', sha256: '0'.repeat(64) })).toEqual({
        ok: false,
        reason: 'sha256_mismatch',
      });
      expect(await readFile(count, 'utf8')).toBe('--version\n--version\n');
      await expect(checkOapBinary('oapx', { version: '0.1.0', sha256 })).rejects.toThrow(
        'absolute'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
