import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import {
  CodingPrEventRepository,
  deliverCodingPrEvents,
} from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import {
  CodingPrSweepRepository,
  sweepCodingPrs,
} from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function fixture() {
  const db = new Database(':memory:');
  dbs.push(db);
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const messages: string[] = [];
  const deps = {
    tell: async (_ref: unknown, _key: string, text: string) => {
      messages.push(text);
      return true;
    },
    wake: async (_key: string, text: string) => {
      messages.push(text);
      return true;
    },
  };
  const save = (key: string, value: unknown, scope = 'lsm/qlark', kind = 'repo') =>
    db
      .prepare(
        `INSERT OR REPLACE INTO neo_pack_preferences VALUES ('coding', ?, ?, ?, ?, 'human', 1)`
      )
      .run(kind, scope, key, JSON.stringify(value));
  const cycle = async (
    minute: number,
    ci: string | null = 'SUCCESS',
    reviews = [
      { state: 'APPROVED', commit: { oid: 'head' }, author: { login: 'hyperneo-ai-test' } },
    ],
    extra = {}
  ) => {
    const now = minute * 60000;
    const raw = {
      data: {
        rateLimit: { remaining: 4000 },
        repository: {
          nameWithOwner: 'lsm/qlark',
          open: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                number: 19,
                title: 'Design sign-off',
                headRefName: 'design',
                headRefOid: 'head',
                state: 'OPEN',
                isDraft: false,
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                closedAt: null,
                reviews: { nodes: reviews },
                commits: { nodes: [{ commit: { statusCheckRollup: ci ? { state: ci } : null } }] },
                files: {
                  nodes: [{ path: 'docs/design/approved.md' }],
                  pageInfo: { hasNextPage: false },
                },
                ...extra,
              },
            ],
          },
          done: { nodes: [] },
        },
      },
    };
    const transitions = await reconcileCodingPrLedger(ledger, ['lsm/qlark'], async () => raw, now);
    db.prepare('UPDATE pack_coding_pr_ledger SET owner = ?').run(
      JSON.stringify({ adapter: 'codex', id: 'synthetic' })
    );
    await deliverCodingPrEvents(new CodingPrEventRepository(db), transitions, deps);
    await sweepCodingPrs(new CodingPrSweepRepository(db), deps, now);
    return ledger.list()[0].state;
  };
  return { db, ledger, save, cycle, messages };
}

describe('policy-aware merge readiness', () => {
  test('qlark#19 replay: bot approval plus 20 minutes never nudges a human-signoff design to merge', async () => {
    const { save, cycle, messages } = fixture();
    save('mergePolicy', 'review_bot');
    save('reviewBot', 'hyperneo-ai-test');
    save('humanSignoff', ['docs/design/**']);
    await cycle(0, 'PENDING', []);
    expect(await cycle(1)).toBe('waiting_human');
    expect(await cycle(21)).toBe('waiting_human');
    expect(await cycle(61)).toBe('waiting_human');
    expect(messages.some((text) => /merge/i.test(text))).toBe(false);
  });
  test.each([
    [undefined, 'SUCCESS', 'waiting_human'],
    [undefined, 'PENDING', 'waiting_human'],
    ['human', 'SUCCESS', 'waiting_human'],
    ['human', 'PENDING', 'waiting_ci'],
    ['ci_only', 'SUCCESS', 'approved_green'],
    ['ci_only', 'PENDING', 'waiting_ci'],
    ['review_bot', 'SUCCESS', 'approved_green'],
    ['review_bot', 'PENDING', 'approved_pending'],
  ])('%s with %s becomes %s', async (policy, ci, expected) => {
    const { save, cycle } = fixture();
    if (policy) save('mergePolicy', policy);
    save('reviewBot', 'hyperneo-ai-test');
    expect(await cycle(0, ci)).toBe(expected);
  });
  test('only the designated bot on this head counts; missing bot fails closed', async () => {
    const { save, cycle } = fixture();
    save('mergePolicy', 'review_bot');
    expect(await cycle(0)).toBe('waiting_human');
    save('reviewBot', 'hyperneo-ai-test');
    expect(
      await cycle(1, 'SUCCESS', [
        { state: 'APPROVED', commit: { oid: 'head' }, author: { login: 'human' } },
      ])
    ).toBe('waiting_review');
    expect(
      await cycle(2, 'SUCCESS', [
        { state: 'APPROVED', commit: { oid: 'old' }, author: { login: 'hyperneo-ai-test' } },
      ])
    ).toBe('waiting_review');
    expect(await cycle(3)).toBe('approved_green');
  });
  test('waiting_ci uses the 20/40/60 ladder without merge wording, including escalation', async () => {
    const { save, cycle, messages } = fixture();
    save('mergePolicy', 'ci_only');
    await cycle(0, 'PENDING');
    await cycle(19, 'PENDING');
    expect(messages).toEqual([]);
    for (const [minute, count] of [
      [20, 1],
      [40, 2],
      [60, 3],
      [120, 3],
    ]) {
      await cycle(minute, 'PENDING');
      expect(messages.length).toBe(count);
    }
    expect(messages.length).toBe(3);
    expect(messages.every((text) => !/merge/i.test(text))).toBe(true);
  });
  test.each(['review_bot', 'ci_only', 'human'])(
    'fix-it/terminal states survive %s, and no-CI is green when policy permits',
    async (policy) => {
      const { save, cycle } = fixture();
      save('mergePolicy', policy);
      save('reviewBot', 'hyperneo-ai-test');
      const review = [
        {
          state: 'CHANGES_REQUESTED',
          commit: { oid: 'head' },
          author: { login: 'hyperneo-ai-test' },
        },
      ];
      expect(await cycle(0, 'FAILURE')).toBe('failing');
      expect(await cycle(1, 'SUCCESS', review)).toBe('changes_requested');
      expect(await cycle(2, 'SUCCESS', [], { isDraft: true })).toBe('draft');
      expect(await cycle(3, 'SUCCESS', [], { mergeable: 'CONFLICTING' })).toBe('dirty');
      expect(await cycle(4, 'SUCCESS', [], { state: 'MERGED' })).toBe('merged');
      expect(await cycle(5, 'SUCCESS', [], { state: 'CLOSED' })).toBe('closed');
      expect(await cycle(6, null)).toBe(policy === 'human' ? 'waiting_human' : 'approved_green');
    }
  );

  test('repository case and same-pack global fallback preserve human answers', async () => {
    const { save, cycle } = fixture();
    save('mergePolicy', 'ci_only', 'LSM/Qlark');
    expect(await cycle(0)).toBe('approved_green');
    save('mergePolicy', 'human', '', 'global');
    expect(await cycle(1)).toBe('approved_green');
  });
});
