import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { withArtifactDescriptor } from '../../../../src/lib/runtime-artifact-open.ts';

describe('artifact descriptor boundary', () => {
  test('proves actual native no-follow opens and races in a separate Bun runtime', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-safe-open-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [resolve('../../.claude/skills/verify/preview-safe-open.ts'), root],
        {
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        exactBytes: true,
        symlinksDenied: true,
        hardlinksDenied: true,
        descriptorStable: true,
        parentRaceContained: true,
        descriptorsClosed: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('fails closed when the native backend is unavailable', async () => {
    const result = await withArtifactDescriptor('/synthetic', ['report.md'], () => {
      throw new Error('unavailable backend must not call the consumer');
    });
    expect(result).toEqual({
      accepted: false,
      reason: process.versions.bun ? 'unsafe_path' : 'safe_open_unavailable',
    });
  });
});
