import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('immutable Git reference resolution', () => {
  test('publishes exact Git snapshots with provenance behind current source authority', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-git-resolve-')));
    mkdirSync(join(root, 'home'));
    try {
      const output = execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/preview-git-resolve.ts',
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
        sourceBound: true,
        immutableHead: true,
        fullRead: true,
        provenance: true,
        racesRefused: true,
        localLabel: true,
        revoked: true,
        restart: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
