import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Space extension configuration query extraction', () => {
  test('public Space configuration RPC preserves values through the extracted queries', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extension-space-read-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-extension-space-read-extract.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/extension-space-read-extract.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        mainThreadMovementClaim: false,
        workerActivation: false,
        publicRpcValuesPreserved: true,
        enabledOrderingAndSourceIsolationPreserved: true,
        validationBeforeQueriesPreserved: true,
        suppliedConnectionAndRollbackPreserved: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
