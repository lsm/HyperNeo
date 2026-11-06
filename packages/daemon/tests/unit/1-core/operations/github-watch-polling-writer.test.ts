import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('Public watch polling writer', () => {
  test('native watch polling intent and config commit off main', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'github-watch-polling-writer-')));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/github-watch-polling-writer.ts',
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
        JSON.parse(readFileSync(join(root, 'evidence/github-watch-polling-writer.json'), 'utf8'))
      ).toMatchObject({
        pass: true,
        snapshotFailureRollsBackWatchAndIntent: true,
        configuredDisabledKeepsIntent: true,
        lastConfiguredRowClearsIntent: true,
        unknownCommitIncludesConfigWithoutReplay: true,
        admissionFailurePreservesCluster: true,
        mainPollingSql: 0,
        nativeWriterLaneObserved: true,
        resourcesStopped: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
