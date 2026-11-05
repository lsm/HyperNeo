import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Space extension configuration SQL extraction', () => {
  test('real GitHub Space enable and disable preserve persisted configuration', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extension-space-sql-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-extension-space-sql-extract.ts',
              import.meta.url
            )
          ),
          root,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: join(root, 'home'),
            TMPDIR: root,
            NODE_ENV: 'test',
            HYPERNEO_DATA_DIR: join(root, 'data'),
            LOG_LEVEL: 'warn',
          },
          timeout: 30000,
          stdio: 'pipe',
        }
      );
      expect(
        JSON.parse(readFileSync(join(root, 'evidence/extension-space-sql-extract.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        mainThreadMovementClaim: false,
        publicRpc: { mainUpsertRuns: 0, exactSettingsAndCreationTimePreserved: true },
        suppliedTimeRollbackAndCascadePreserved: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
