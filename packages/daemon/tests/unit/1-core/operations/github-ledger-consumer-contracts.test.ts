import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function observe(scenario: string) {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'github-ledger-contract-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/github-ledger-consumers.ts',
            import.meta.url
          )
        ),
        scenario,
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
        timeout: 30_000,
        encoding: 'utf8',
      }
    );
    return JSON.parse(readFileSync(join(run, 'evidence/consumers.json'), 'utf8'));
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

describe('GitHub reader acquisition contracts', () => {
  test('a merged PR agrees across public reads, branch membership, deployment and ledger', () => {
    const result = observe('merged');
    expect(result.verified).toBe(true);
    expect(result.first.detail).toMatchObject({
      ok: true,
      state: 'MERGED',
      review: 'approved',
      checks: 'none',
    });
    expect(result.first.deploy.daemons[0].contains).toEqual(['c'.repeat(40)]);
    expect(result.first.ledger[0]).toMatchObject({ pr: 'synthetic/ledger#7', state: 'merged' });
    expect(
      Object.values(result.initialRequests).reduce((sum: number, count) => sum + Number(count), 0)
    ).toBe(7);
    expect(result.repeatRequests).toEqual({
      'query-window': 1,
    });
    expect(result.ledgerGraphqlCost).toBe(0);
  }, 20000);

  test('a changed head cannot keep the prior approval and still shows unresolved-thread blockers', () => {
    const result = observe('head');
    expect(result.verified).toBe(true);
    expect(result.first).toMatchObject({
      review: 'approved',
      blockers: ['1 unresolved review thread'],
    });
    expect(result.changed).toMatchObject({
      review: 'none',
      blockers: ['1 unresolved review thread'],
    });
  }, 20000);

  test('failed public reads refuse, a complete empty list succeeds, and a partial reconcile keeps prior facts', () => {
    const result = observe('unreadable');
    expect(result.verified).toBe(true);
    expect(result.failedDetail).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unreadable'),
    });
    expect(result.failedList).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unreadable'),
    });
    expect(result.issue).toMatchObject({
      kind: 'issue',
      closedAs: 'completed',
      closedBy: 'https://github.com/synthetic/ledger/pull/7',
      parent: 'https://github.com/synthetic/ledger/issues/1',
    });
    expect(result.empty).toMatchObject({ ok: true, items: [] });
    expect(result.before).toHaveLength(1);
    expect(result.after).toEqual(result.before);
  }, 20000);
});
