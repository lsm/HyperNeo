import { expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';

const repo = 'synthetic/reviewed';
const url = `https://github.com/${repo}/pull/78`;
const identity = { model: 'gpt-6.1-sol', effort: 'high', harness: 'codex-desktop' };
const facts = `${repo} merge policy: review_bot; review bot: hyperneo-ai-test; human sign-off: docs/design/**; merge by: owner`;
const owner = { adapter: 'hyperneo', id: 'worker' };

function fixture(saved = true) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db, 0);
  db.prepare('UPDATE pack_coding_pr_unowned_state SET activated_at = 0').run();
  const preference = (key: string, value: unknown, scope = repo) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO neo_pack_preferences VALUES ('coding','repo',?,?,?,'human',1)"
      )
      .run(scope, key, JSON.stringify(value));
  if (saved) {
    preference('mergePolicy', 'review_bot');
    preference('reviewBot', 'hyperneo-ai-test');
    preference('humanSignoff', ['docs/design/**']);
  }
  const state = { ci: 'PENDING', accepted: true };
  const told: { key: string; text: string }[] = [];
  const woken: { key: string; text: string }[] = [];
  const pack = createCodingPack({
    database: () => db,
    readPrs: async () => [],
    readClaudeOwners: async () => [],
    projectRepos: () => [repo],
    prLedger: new CodingPrLedgerRepository(db),
    prEvents: new CodingPrEventRepository(db),
    prSweep: new CodingPrSweepRepository(db),
    todoPrs: new CodingTodoPrRepository(db),
    readLedgerRepo: async () => ({
      data: {
        rateLimit: { remaining: 4000 },
        repository: {
          nameWithOwner: repo,
          open: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                number: 78,
                title: 'Review and merge',
                author: { login: 'worker-author', __typename: 'User' },
                headRefName: 'change',
                headRefOid: 'a'.repeat(40),
                state: 'OPEN',
                isDraft: false,
                mergeable: 'MERGEABLE',
                reviewDecision: 'APPROVED',
                files: { nodes: [{ path: 'src/main.ts' }], pageInfo: { hasNextPage: false } },
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
                reviews: {
                  nodes: [
                    {
                      state: 'APPROVED',
                      commit: { oid: 'a'.repeat(40) },
                      author: { login: 'hyperneo-ai-test', type: 'Bot' },
                    },
                  ],
                },
                createdAt: new Date(1).toISOString(),
                closedAt: null,
                commits: {
                  nodes: [{ commit: { statusCheckRollup: { state: state.ci } } }],
                },
              },
            ],
          },
          done: { nodes: [] },
        },
      },
    }),
    prSweepDeps: {
      tell: async (_ref, key, text) => {
        told.push({ key, text });
        return state.accepted;
      },
      wake: async (key, text) => {
        woken.push({ key, text });
        return true;
      },
    },
  });
  const own = () => {
    db.prepare('UPDATE pack_coding_pr_ledger SET owner = ?').run(JSON.stringify(owner));
    told.length = woken.length = 0;
  };
  return { db, pack, preference, state, told, woken, own };
}

test('worker PR context includes saved reviewed merge facts and keeps observed provenance', () => {
  const f = fixture();
  try {
    const brief = f.pack.workerBrief!(`Continue ${url}.`, identity);
    expect(brief).toContain(facts);
    expect(brief).toMatch(/^Worker delivery: /);
    expect(brief).toContain('Agent: gpt-6.1-sol (effort: high) via Codex');
    expect(brief).toContain(`Continue ${url}.`);
  } finally {
    f.db.close();
  }
});

test('briefs identify named repositories and deduplicate case, URL and shorthand references', () => {
  const f = fixture();
  try {
    f.preference('mergePolicy', 'human', 'other/project');
    const brief = f.pack.workerBrief!(
      `Work in SYNTHETIC/REVIEWED; ${url}, synthetic/reviewed#79 and other/project#1.`,
      identity
    );
    expect(brief.split(facts)).toHaveLength(2);
    expect(brief).toContain('other/project merge policy: human');
    expect(f.pack.workerBrief!('Work in SYNTHETIC/REVIEWED.', identity)).toContain(facts);
    expect(f.pack.workerBrief!('Work in synthetic/reviewed-extra.', identity)).not.toContain(facts);
    expect(f.pack.workerBrief!('Work in synthetic/reviewed.md.', identity)).not.toContain(facts);
  } finally {
    f.db.close();
  }
});

test('PR goals carry facts when a short follow-up does not name the repository', () => {
  const f = fixture();
  try {
    const brief = f.pack.workerBrief!('Continue.', identity);
    const goal = f.pack.workGoal!(brief, {
      workId: 'todo',
      goal: null,
      doneWhen: `${url} approved`,
      checkKind: 'pr_approved',
    });
    expect(goal).toContain(facts);
    const named = f.pack.workGoal!(f.pack.workerBrief!(`Continue ${url}.`, identity), {
      workId: 'todo',
      goal: null,
      doneWhen: `${url} approved`,
      checkKind: 'pr_approved',
    });
    expect(named.split(facts)).toHaveLength(2);
  } finally {
    f.db.close();
  }
});

test('missing settings are explicit and reading context never saves defaults', () => {
  const f = fixture(false);
  try {
    const before = f.db.prepare('SELECT * FROM neo_pack_preferences').all();
    const brief = f.pack.workerBrief!(`Continue ${url}.`, identity);
    expect(brief).toContain('merge policy: not configured; review bot: not configured');
    expect(brief).toContain('human sign-off: none; merge by: owner');
    expect(f.db.prepare('SELECT * FROM neo_pack_preferences').all()).toEqual(before);
  } finally {
    f.db.close();
  }
});

test('owned PR events and retried deliveries include the current saved facts', async () => {
  const f = fixture();
  try {
    await f.pack.sweep!(100);
    f.own();
    f.state.ci = 'FAILURE';
    f.state.accepted = false;
    await f.pack.sweep!(200);
    expect(f.told[0].text).toContain(facts);
    f.preference('mergeBy', 'daemon');
    f.state.accepted = true;
    await f.pack.sweep!(300);
    expect(f.told[1].key).toBe(f.told[0].key);
    expect(f.told[1].text).toContain('merge by: daemon');
    const brief = f.pack.workerBrief!(`Continue ${url}.`, identity);
    expect(brief).toContain('merge by: daemon');
  } finally {
    f.db.close();
  }
});

test('PR reminders and Neo escalation carry the same saved merge facts', async () => {
  const f = fixture();
  try {
    await f.pack.sweep!(100);
    f.own();
    for (const minutes of [20, 40, 60]) await f.pack.sweep!(100 + minutes * 60_000);
    expect(f.told).toHaveLength(2);
    for (const message of [...f.told, ...f.woken]) expect(message.text).toContain(facts);
    expect(f.woken.some((message) => message.text.includes('has made no progress'))).toBe(true);
  } finally {
    f.db.close();
  }
});

test('unowned PR notifications give Neo the repository merge facts', async () => {
  const f = fixture();
  try {
    await f.pack.sweep!(100);
    const notice = f.woken.find((message) => message.text.includes('without a known worker'));
    expect(notice?.text).toContain(facts);
  } finally {
    f.db.close();
  }
});
