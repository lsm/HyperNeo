import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('default deploy reader ledger contract', () => {
  test('covered merges survive refused GitHub reads and reopen; missing reads coalesce and failures stay unknown', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-ledger-rpc-')));
    mkdirSync(join(run, 'home'));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/github-ledger-deploy-merge.ts',
              import.meta.url
            )
          ),
          run,
        ],
        {
          env: {
            HOME: join(run, 'home'),
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            HYPERNEO_DATA_DIR: join(run, 'data'),
            LOG_LEVEL: 'error',
          },
          timeout: 30_000,
          stdio: 'pipe',
        }
      );
      const proof = JSON.parse(readFileSync(join(run, 'evidence/deploy-merge.json'), 'utf8'));
      expect(proof.verified).toBe(true);
      expect(proof.mergeCounts).toEqual({
        known: 0,
        missing: 1,
        repeat: 0,
        reopen: 0,
        failed: 1,
        partial: 1,
        recovered: 1,
        closed: 1,
      });
      expect(proof.known.prs[0].mergeCommit).toBe('c'.repeat(40));
      expect(proof.concurrent).toHaveLength(5);
      expect(proof.failed.reason).toBe('failed');
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 30_000);
});
