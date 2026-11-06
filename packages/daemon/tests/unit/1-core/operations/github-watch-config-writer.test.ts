import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Public watched repository atomic writer', () => {
  test('native watch configuration commits atomically off main', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-watch-config-writer-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/github-watch-config-writer.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-watch-config-writer.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        failedClearRollsBackUpsert: true,
        committedSanitizedReceipt: true,
        unknownCommitNeverReplayed: true,
        admissionFailurePreservesRow: true,
        mainConfigSql: 0,
        nativeWriterLaneObserved: true,
        resourcesStopped: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
