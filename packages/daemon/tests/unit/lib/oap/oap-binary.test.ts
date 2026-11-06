import { describe, expect, test } from 'bun:test';
import { decideBinaryCheck } from '../../../../src/lib/oap/oap-binary';

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
