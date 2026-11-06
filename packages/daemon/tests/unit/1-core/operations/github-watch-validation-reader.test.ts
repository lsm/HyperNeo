import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Public watched repository validation reader', () => {
  test('native watch validation reads off main before mutations', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-watch-validation-reader-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/github-watch-validation-reader.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-watch-validation-reader.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        caseAndSanitizedReceipt: true,
        lostReadReceiptHasNoFallbackOrMutation: true,
        mainValidationReads: 0,
        nativeReadLaneObserved: true,
        resourcesStopped: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
