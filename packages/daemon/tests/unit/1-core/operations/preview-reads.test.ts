import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactReadOperations } from '../../../../src/lib/artifacts/read-operations.ts';

describe('registered artifact reads', () => {
  test('constructs read discovery without touching SQLite', () => {
    const entries = createArtifactReadOperations(() => {
      throw new Error('discovery touched SQLite');
    });
    expect(entries.map((entry) => entry.name)).toEqual([
      'artifact.file.get',
      'artifact.file.list',
      'artifact.file.read',
    ]);
    expect(entries.every((entry) => entry.policy?.safetyClass === 'read')).toBe(true);
  });
  test('proves authorized bounded reads and integrity in actual Bun', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-reads-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL('../../../../../../.claude/skills/verify/preview-reads.ts', import.meta.url)
          ),
          root,
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: join(root, 'home'), NODE_ENV: 'test' },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        exactBytes: true,
        boundedReads: true,
        scopedPagination: true,
        authorityRechecked: true,
        tamperingRefused: true,
        sourceIndependent: true,
        restartPreserved: true,
        readonlyMetadata: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
