import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('worker completion consumes ledger state and refuses unavailable evidence', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'completion-ledger-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/github-ledger-completion-gate.ts',
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
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    const proof = JSON.parse(readFileSync(join(run, 'evidence/completion-gate.json'), 'utf8'));
    expect(proof.verified).toBe(true);
    expect(proof.knownStatus).toBe('done');
    expect(proof.coldReads).toBe(1);
    expect(proof.cold).toHaveLength(5);
    expect(proof.counts).toEqual({ cold: 1, open: 1, closed: 1, merged: 1, failed: 1, partial: 1 });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
