import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNeoCodingReaders } from '../../../../../src/lib/neo/packs/runtime.ts';

test('ledger connector PR acquisition preserves payload, freshness and failure history', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'connector-pr-ledger-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../../.claude/skills/verify/github-ledger-connector-get-pr.ts',
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
    const proof = JSON.parse(readFileSync(join(run, 'evidence/connector-pr.json'), 'utf8'));
    expect(proof.verified).toBe(true);
    expect(proof.coldReads).toBe(1);
    expect(proof.historyPreserved).toBe(true);
    expect(proof.productionConnectorWired).toBe(false);
    expect(proof.counts).toEqual({
      cold: 1,
      repeat: 1,
      merged: 1,
      failed: 1,
      partial: 1,
      recovered: 1,
      alias: 1,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('invalid and foreign PR identities fail before DB or GitHub access', async () => {
  const read = createNeoCodingReaders(() => {
    throw new Error('Unexpected database access');
  }).readConnectorPr;
  for (const url of ['not-a-pr', 'https://untrusted.invalid/synthetic/repo/pull/7']) {
    const result = await read(url, '/tmp');
    expect(result.ok).toBe(false);
  }
});
