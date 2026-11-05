import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Global extension configuration lookup extraction', () => {
  test('public extension list preserves configurations through the extracted lookup', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extension-global-read-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-extension-global-read-extract.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/extension-global-read-extract.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        mainThreadMovementClaim: false,
        workerActivation: false,
        publicListCharacterized: true,
        publicGetterNowReaderBacked: true,
        publicMainReads: 0,
        suppliedConnectionAndRollbackPreserved: true,
        validationBeforeLookupPreserved: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
