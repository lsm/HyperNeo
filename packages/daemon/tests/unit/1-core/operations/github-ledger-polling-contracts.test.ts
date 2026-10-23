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
    ).toEqual(scenario === 'failure' ? [9, 8, 9] : [9, 9]);
  }, 30000);
}

test('existing conditional and large-response RPC journey completes with read-checkout sync enabled', () => {
  const result = proof('github-poll-responses.ts', 'verify', 'responses.json');
  expect(result.verified).toBe(true);
  expect(result.cycles.at(-1).reply).toEqual({ count: 0 });
  expect(result.cycles.at(-1).storedComments).toBe(100);
}, 30000);

test('expired raw pages do not accumulate as polling windows advance; legacy rows and history survive', () => {
  const result = proof('github-ledger-polling.ts', 'retention', 'polling-ledger.json');
  expect(result.verified).toBe(true);
  expect(result.protectedRowsUnchanged).toBe(true);
  expect(result.cycles.map((cycle: { events: unknown[] }) => cycle.events.length)).toEqual([
    2, 2, 2,
  ]);
  expect(result.cycles.map((cycle: { pages: unknown[] }) => cycle.pages.length)).toEqual([
    10, 10, 10,
  ]);
}, 30000);

test('cold and expired destination validators seed shared bodies once and then reuse valid 304 coverage', () => {
  const result = proof('github-ledger-polling.ts', 'conditional-reseed', 'polling-ledger.json');
  expect(result.verified).toBe(true);
  expect(result.cycles.map((cycle: { events: unknown[] }) => cycle.events.length)).toEqual([
    2, 2, 2,
  ]);
  expect(
    result.cycles.map((cycle: { pages: { reason: string | null }[] }) =>
      cycle.pages.every((page) => page.reason === null)
    )
  ).toEqual([true, true, true]);
}, 30000);

test('slow configured polling keeps 304 payload reuse across its interval and expires inactive raw pages', () => {
  const result = proof('github-ledger-polling.ts', 'slow-conditional', 'polling-ledger.json');
  expect(result.verified).toBe(true);
  expect(result.configuredIntervalMs).toBe(1800_000);
  expect(result.cycles.map((cycle: { events: unknown[] }) => cycle.events.length)).toEqual([
    2, 2, 2,
  ]);
  const repeat = result.requests.find(
    (r: { phase: string; path: string }) =>
      r.phase === 'repeat' && r.path.includes('/pulls/7/reviews')
  );
  expect(repeat.status).toBe(304);
  expect(repeat.bodyBytes).toBe(0);
}, 30000);
