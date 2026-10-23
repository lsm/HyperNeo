import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';

function proof(helper: string, mode: string, evidence: string) {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'poll-ledger-contract-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(`../../../../../../.claude/skills/verify/${helper}`, import.meta.url)
        ),
        mode,
        run,
      ],
      {
        cwd: run,
        env: {
          HOME: join(run, 'home'),
          PATH: `${join(run, 'bin')}:${process.env.PATH}`,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'error',
        },
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    return JSON.parse(readFileSync(join(run, 'evidence', evidence), 'utf8'));
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

for (const scenario of ['normal', 'conditional', 'failure']) {
  test(`shared-repository ${scenario} keeps head-scoped approvals in both destinations`, () => {
    const result = proof('github-ledger-polling.ts', scenario, 'polling-ledger.json');
    expect(result.verified).toBe(true);
    expect(result.productionWired).toBe(true);
    expect(result.codingPackDisabled).toBe(true);
    expect(result.duplicateInitialReviewReads).toBe(1);
    expect(result.cycles.map((cycle: { events: unknown[] }) => cycle.events.length)).toEqual(
      scenario === 'failure' ? [2, 2, 4] : [2, 2]
    );
    expect(
      result.requests.filter(
        (r: { phase: string; path: string }) => r.phase === 'initial' && r.path !== '/user'
      ).length
    ).toBe(9);
    const phases =
      scenario === 'failure' ? ['initial', 'failed', 'recovered'] : ['initial', 'repeat'];
    expect(
      phases.map(
        (phase) =>
          result.requests.filter(
            (r: { phase: string; path: string }) => r.phase === phase && r.path !== '/user'
          ).length
      )
    ).toEqual(scenario === 'failure' ? [9, 8, 9] : [9, scenario === 'conditional' ? 10 : 9]);
  }, 30000);
}

test('existing conditional and large-response RPC journey completes with read-checkout sync enabled', () => {
  const result = proof('github-poll-responses.ts', 'verify', 'responses.json');
  expect(result.verified).toBe(true);
  expect(result.cycles.at(-1).reply).toEqual({ count: 0 });
  expect(result.cycles.at(-1).storedComments).toBe(100);
}, 30000);
