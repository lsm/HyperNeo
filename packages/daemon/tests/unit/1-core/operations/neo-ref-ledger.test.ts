import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

test('public reference and project reads share acquisition without masking failure or changed branch evidence', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'ref-ledger-rpc-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/github-ledger-refs.ts', import.meta.url)
        ),
        run,
      ],
      {
        cwd: run,
        env: {
          HOME: join(run, 'home'),
          PATH: process.env.PATH!,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'error',
        },
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    const result = JSON.parse(readFileSync(join(run, 'evidence/ref-ledger.json'), 'utf8'));
    expect(result.verified).toBe(true);
    expect(result.fanout).toHaveLength(5);
    expect(result.counts).toEqual({ initial: 1, changed: 1, failed: 1, reopen: 1 });
    expect(result.issueLookups).toBe(1);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 30000);
