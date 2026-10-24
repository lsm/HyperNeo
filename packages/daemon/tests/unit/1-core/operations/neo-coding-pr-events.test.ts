import { describe, expect, test } from 'bun:test';
import {
  CodingPrEventRepository,
  deliverCodingPrEvents,
  planCodingPrEvent,
} from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import {
  CodingPrLedgerRepository,
  reconcileCodingPrLedger,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const owner = { adapter: 'claude-desktop', id: 'worker-1' };

const node = (number: number, more: Record<string, unknown> = {}, ci = 'SUCCESS') => ({
  number,
  title: `PR ${number}`,
  headRefName: `b${number}`,
  headRefOid: `head${number}abc`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  reviews: { nodes: [] },
  closedAt: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
  ...more,
});

const response = (open: unknown[], done: unknown[] = []) => ({
  data: {
    rateLimit: { remaining: 4000 },
    repository: {
      nameWithOwner: 'lsm/a',
      open: { pageInfo: { hasNextPage: false }, nodes: open },
      done: { nodes: done },
    },
  },
});

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const events = new CodingPrEventRepository(db);
  const told: { ref: unknown; key: string; text: string }[] = [];
  const woken: { key: string; text: string }[] = [];
  const deps = {
    tell: async (ref: unknown, key: string, text: string) => {
      told.push({ ref, key, text });
      return true;
    },
    wake: async (key: string, text: string) => {
      woken.push({ key, text });
      return true;
    },
  };
  const cycle = async (raw: unknown, now: number) =>
    deliverCodingPrEvents(
      events,
      await reconcileCodingPrLedger(ledger, ['lsm/a'], async () => raw, now),
      deps
    );
  const own = (number: number) =>
    db
      .prepare('UPDATE pack_coding_pr_ledger SET owner = ? WHERE number = ?')
      .run(JSON.stringify(owner), number);
  return { db, told, woken, cycle, own };
}

describe('PR ledger events', () => {
  test('CI recovery and a merge reach the owner once and never Neo', async () => {
    const { db, told, woken, cycle, own } = setup();
    await cycle(response([node(1)]), 100);
    own(1);
    await cycle(response([node(1, {}, 'FAILURE')]), 200);
    await cycle(response([node(1, {}, 'FAILURE')]), 300);
    await cycle(response([node(1)]), 400);
    await cycle(
      response([], [node(1, { state: 'MERGED', closedAt: new Date(450).toISOString() })]),
      500
    );
    await cycle(
      response([], [node(1, { state: 'MERGED', closedAt: new Date(450).toISOString() })]),
      600
    );
    expect(told.map((item) => item.key)).toEqual([
      'neo-pr-event:lsm/a#1:head1abc:failing',
      'neo-pr-event:lsm/a#1:head1abc:waiting_human',
      'neo-pr-event:lsm/a#1:head1abc:merged',
    ]);
    expect(told[0]).toMatchObject({ ref: owner });
    expect(told[1].text).toBe('lsm/a#1 "PR 1" has green CI again on head head1ab.');
    expect(told[2].text).toBe('lsm/a#1 \"PR 1\" was merged on head head1ab.');
    expect(woken).toEqual([]);
    db.close();
  });

  test('an unowned PR stays quiet and a claimed PR receives its ledger event', async () => {
    const { db, told, woken, cycle } = setup();
    await cycle(response([node(1), node(2)]), 100);
    db.prepare(
      `INSERT INTO neo_asks (id, project_id, session_id, origin_message_id, title, request, status, created_at, updated_at)
       VALUES ('ask', NULL, 'neo', NULL, 'A', 'R', 'open', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at)
       VALUES ('t', 'ask', 0, 'T', 'D', 'doing', 1, 1)`
    ).run();
    db.prepare(
      "INSERT INTO pack_coding_pr_claims (todo_id, url, claim, claimed_at) VALUES ('t', 'https://github.com/lsm/a/pull/2', 'named', 1)"
    ).run();
    db.prepare('UPDATE pack_coding_pr_ledger SET owner = ? WHERE number = 2').run(
      JSON.stringify(owner)
    );
    await cycle(response([node(1, {}, 'FAILURE'), node(2, {}, 'FAILURE')]), 200);
    expect(told).toEqual([
      expect.objectContaining({ ref: owner, key: 'neo-pr-event:lsm/a#2:head2abc:failing' }),
    ]);
    expect(woken).toEqual([]);
    db.close();
  });
});

describe('planCodingPrEvent', () => {
  test('names the next step for each state the owner must act on', () => {
    const row = (state: string, from = 'waiting_review') =>
      planCodingPrEvent({
        repo: 'lsm/a',
        number: 3,
        title: 'T',
        branch: 'b',
        head: 'abcdef123',
        state: state as never,
        closedAt: null,
        from: from as never,
      })?.text;
    expect(row('approved_green')).toBe(
      'lsm/a#3 "T" is approved and green on head abcdef1. Merge it now with a manual squash on this head.'
    );
    expect(row('dirty')).toContain('Merge the base branch in');
    expect(row('changes_requested')).toContain('Address the review');
    expect(row('closed')).toBe('lsm/a#3 \"T\" was closed without merging on head abcdef1.');
    expect(row('merged', 'failing')).toBe('lsm/a#3 \"T\" was merged on head abcdef1.');
    const fromFailing = (state: string, ci: string | null) =>
      planCodingPrEvent({
        repo: 'lsm/a',
        number: 3,
        title: 'T',
        branch: 'b',
        head: 'abcdef123',
        state: state as never,
        closedAt: null,
        ci,
        from: 'failing',
      })?.text;
    expect(fromFailing('waiting_review', 'SUCCESS')).toBe(
      'lsm/a#3 "T" has green CI again on head abcdef1.'
    );
    expect(fromFailing('waiting_review', 'PENDING')).toBeUndefined();
    expect(fromFailing('approved_pending', 'PENDING')).toBeUndefined();
    expect(fromFailing('draft', 'FAILURE')).toBeUndefined();
    expect(row('approved_pending')).toBeUndefined();
  });
});
