import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundGitBlob } from '../../../../src/lib/artifacts/git-blob.ts';

describe('immutable bound Git capture', () => {
  test('refuses moving revisions before lookup', async () => {
    expect(
      await readBoundGitBlob({
        repository: 'github.com/lsm/hyperneo',
        sha: 'HEAD',
        path: 'docs/report.md',
      })
    ).toEqual({ accepted: false, reason: 'unavailable' });
  });
  test('proves immutable objects and shared durable capture inputs in actual Bun', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-git-capture-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/preview-git-capture.ts',
              import.meta.url
            )
          ),
          root,
        ],
        {
          cwd: root,
          env: {
            PATH: `${join(root, 'bin')}:${process.env.PATH}`,
            HOME: join(root, 'home'),
            NODE_ENV: 'test',
          },
          encoding: 'utf8',
          timeout: 30000,
        }
      );
      expect(JSON.parse(output)).toMatchObject({
        immutableBytes: true,
        objectVerified: true,
        noSymlink: true,
        bounded: true,
        sharedQuota: true,
        notExposed: true,
        restart: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
