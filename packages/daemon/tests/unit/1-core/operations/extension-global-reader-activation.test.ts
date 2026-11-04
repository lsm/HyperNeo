import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Global extension configuration getter reader activation', () => {
  test('native reader preserves public configuration values without main fallback', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'extension-global-reader-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/lane-c-extension-global-reader-activation.ts',
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
        JSON.parse(
          readFileSync(join(root, 'evidence/extension-global-reader-activation.json'), 'utf8')
        )
      ).toMatchObject({
        pass: true,
        publicGetterActivated: true,
        mainAttempts: 0,
        mainGuardSelfCheckPassed: true,
        standaloneReaderAlreadyWorks: true,
        publicListUsesReaderAndPreservesAllConfigs: true,
        validationBeforeAdmissionPreserved: true,
        committedSnapshotWithCompetingWriterPreserved: true,
        heldReplyKeepsSnapshotAndNextListSeesCommit: true,
        readerFailureRejectsRpcWithoutFallbackOrRetry: true,
        completedReplyLossPropagatesAndIndependentListRecovers: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
