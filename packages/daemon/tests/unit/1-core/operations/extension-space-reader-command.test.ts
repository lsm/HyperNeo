import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Space extension configuration reader construction', () => {
  test('native reader preserves public configuration values without main fallback', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extension-global-reader-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-extension-space-reader-command.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/extension-space-reader-command.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        publicGetterActivationClaim: false,
        mainAttempts: 0,
        publicRpcParityBeforeConstruction: true,
        mainGuardSelfCheckPassed: true,
        nativeCommandsRegistered: true,
        fullConfigsNullsOrderingAndSourceScopePreserved: true,
        committedSnapshotsWithCompetingWriterPreserved: true,
        heldGetAndListSnapshotsSurvivePublicCommit: true,
        bothReaderFailuresRejectWithoutFallbackOrRetry: true,
        bothCompletedReplyLossesRecoverOnIndependentRead: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
