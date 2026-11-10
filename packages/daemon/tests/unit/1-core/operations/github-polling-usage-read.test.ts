import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('GitHub polling usage read construction', () => {
  test('native registered readers preserve usage and query-only snapshot behavior', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-polling-usage-read-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-github-polling-usage-read.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-polling-usage-read.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        publicCallbackActivation: false,
        publicRpcReadback: true,
        precedenceScopesAndErrorsPreserved: true,
        readerFailurePropagatesWithoutFallbackOrWrites: true,
        deferredSnapshotAndFreshReadVerified: true,
        mainSqlAttempts: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
