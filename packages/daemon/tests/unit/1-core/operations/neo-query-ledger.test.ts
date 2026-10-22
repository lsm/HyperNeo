import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('public bounded queries share acquisition without masking later changed, failed or empty reads', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'query-ledger-rpc-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/github-ledger-query.ts', import.meta.url)
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
    const result = JSON.parse(readFileSync(join(run, 'evidence/query-ledger.json'), 'utf8'));
    expect(result.verified).toBe(true);
    expect(result.fanout).toHaveLength(5);
    expect(result.counts).toEqual({ initial: 1, changed: 1, failed: 1, malformed: 1, empty: 1 });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 30000);
