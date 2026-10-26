import { describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '../../../../src/lib/logger.ts';
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

function setup(activatedAt = 0) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db, activatedAt);
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
  return { db, ledger, events, deps, told, woken, cycle, own };
}

describe('PR ledger events', () => {
  test('approval pending CI advances to green and tells a live desktop owner exactly once', async () => {
    const { db, told, cycle } = setup();
    try {
      for (const [key, value] of Object.entries({ mergePolicy: 'review_bot', reviewBot: 'bot' }))
        db.prepare(`INSERT INTO neo_pack_preferences VALUES (?, ?, ?, ?, ?, 'human', 1)`).run(
          'coding',
          'repo',
          'lsm/a',
          key,
          JSON.stringify(value)
        );
      const approved = {
        reviews: {
          nodes: [{ state: 'APPROVED', commit: { oid: 'head1abc' }, author: { login: 'bot' } }],
        },
      };
      await cycle(response([node(1, approved, 'PENDING')]), 100);
      const desktop = { adapter: 'codex-desktop', id: 'synthetic-desktop-owner' };
      db.prepare('UPDATE pack_coding_pr_ledger SET owner = ? WHERE number = 1').run(
        JSON.stringify(desktop)
      );
      expect(db.prepare('SELECT state, told_at FROM pack_coding_pr_ledger').get()).toMatchObject({
        state: 'approved_pending',
        told_at: null,
      });
      expect(told).toEqual([]);
      await cycle(response([node(1, approved, 'SUCCESS')]), 200);
      await cycle(response([node(1, approved, 'SUCCESS')]), 300);
      expect(told).toEqual([
        expect.objectContaining({
          ref: desktop,
          key: 'neo-pr-event:lsm/a#1:head1abc:approved_green',
        }),
      ]);
      expect(db.prepare('SELECT state, told_at FROM pack_coding_pr_ledger').get()).toMatchObject({
        state: 'approved_green',
        told_at: expect.any(Number),
      });
    } finally {
      db.close();
    }
  });

  test('attributed quota deferral resumes pending-owner delivery at reset', async () => {
    const { db, ledger, events, deps, told, cycle, own } = setup();
    try {
      for (const [key, value] of Object.entries({ mergePolicy: 'review_bot', reviewBot: 'bot' }))
        db.prepare(`INSERT INTO neo_pack_preferences VALUES (?, ?, ?, ?, ?, 'human', 1)`).run(
          'coding',
          'repo',
          'lsm/a',
          key,
          JSON.stringify(value)
        );
      const approved = {
        reviews: {
          nodes: [{ state: 'APPROVED', commit: { oid: 'head1abc' }, author: { login: 'bot' } }],
        },
      };
      await cycle(response([node(1, approved, 'PENDING')]), 100);
      own(1);
      const reads: string[] = [];
      let limited = true;
      let cycleAt = 200;
      const quota = {
        status: 429,
        resource: 'graphql' as const,
        remaining: 0,
        resetAt: 1000,
        requestId: 'synthetic',
        retryAfterMs: null,
        credentialBucket: 'synthetic:1',
        retryAt: 1000,
      };
      const read = async (
        repo: string,
        previous?: import('../../../../src/lib/neo/packs/coding/ledger-quota.ts').LedgerQuota
      ) => {
        if (previous?.retryAt && cycleAt < previous.retryAt)
          return {
            error: 'GitHub acquisition cooldown',
            retryAt: 1000,
            quota: { ...previous, deferred: true },
          };
        reads.push(repo);
        return limited
          ? { error: 'HTTP 429', retryAt: 1000, quota }
          : {
              data: {
                ...response(repo === 'lsm/a' ? [node(1, approved)] : []).data,
                repository: {
                  ...response(repo === 'lsm/a' ? [node(1, approved)] : []).data.repository,
                  nameWithOwner: repo,
                },
              },
            };
      };
      const sweep = async (now: number) => {
        cycleAt = now;
        await deliverCodingPrEvents(
          events,
          await reconcileCodingPrLedger(ledger, ['synthetic/empty', 'lsm/a'], read, now),
          deps
        );
      };
      await sweep(200);
      await sweep(999);
      expect(reads).toEqual(['synthetic/empty', 'lsm/a']);
      expect(ledger.stateOf('https://github.com/lsm/a/pull/1')).toBe('approved_pending');
      expect(told).toEqual([]);
      limited = false;
      await sweep(1000);
      await sweep(1001);
      expect(told).toEqual([
        expect.objectContaining({ key: 'neo-pr-event:lsm/a#1:head1abc:approved_green' }),
      ]);
      expect(db.prepare('SELECT state,told_at FROM pack_coding_pr_ledger').get()).toMatchObject({
        state: 'approved_green',
        told_at: expect.any(Number),
      });
    } finally {
      db.close();
    }
  });

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

  test('a terminal observation survives a lost transition return and retries on the next sweep', async () => {
    const { db, ledger, told, cycle, own } = setup();
    try {
      await cycle(response([node(8548)]), 100);
      own(8548);
      const merged = response(
        [],
        [node(8548, { state: 'MERGED', closedAt: new Date(150).toISOString() })]
      );
      await reconcileCodingPrLedger(ledger, ['lsm/a'], async () => merged, 200);
      expect(told).toHaveLength(0);
      await cycle(merged, 300);
      expect(told).toEqual([
        expect.objectContaining({ key: 'neo-pr-event:lsm/a#8548:head8548abc:merged', ref: owner }),
      ]);
      await cycle(merged, 400);
      expect(told).toHaveLength(1);
      expect(
        db.prepare('SELECT told_at FROM pack_coding_pr_ledger WHERE number=8548').get()
      ).toMatchObject({ told_at: expect.any(Number) });
    } finally {
      db.close();
    }
  });

  test('a newly merged first observation waits for its owner, survives a rejected tell and repository restart', async () => {
    const { db, events, ledger, deps, told, cycle, own } = setup(100);
    try {
      const merged = response(
        [],
        [node(8548, { state: 'MERGED', closedAt: new Date(150).toISOString() })]
      );
      await cycle(merged, 200);
      expect(told).toHaveLength(0);
      own(8548);
      await deliverCodingPrEvents(events, [], { ...deps, tell: async () => false });
      await deliverCodingPrEvents(new CodingPrEventRepository(db), [], deps);
      expect(told).toHaveLength(1);
      await cycle(merged, 300);
      expect(told).toHaveLength(1);
      expect(ledger.list()[0].state).toBe('merged');
    } finally {
      db.close();
    }
  });

  test('terminal history predating activation is not replayed to existing owners', async () => {
    const { db, events, deps, told, cycle, own } = setup(1000);
    try {
      await cycle(
        response([], [node(1, { state: 'MERGED', closedAt: new Date(50).toISOString() })]),
        1100
      );
      own(1);
      await deliverCodingPrEvents(events, [], deps);
      expect(told).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test('overlapping delivery sweeps serialize terminal handoffs', async () => {
    const { db, ledger, events, deps, told, cycle, own } = setup();
    try {
      await cycle(response([node(1)]), 100);
      own(1);
      await reconcileCodingPrLedger(
        ledger,
        ['lsm/a'],
        async () =>
          response([], [node(1, { state: 'MERGED', closedAt: new Date(150).toISOString() })]),
        200
      );
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = deliverCodingPrEvents(events, [], {
        ...deps,
        tell: async (ref, key, text) => {
          entered();
          await barrier;
          return deps.tell(ref, key, text);
        },
      });
      await started;
      const second = deliverCodingPrEvents(events, [], deps);
      release();
      await Promise.all([first, second]);
      expect(told).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('legacy schema activation persists and leaves old terminal rows quiet', async () => {
    const { db, ledger, events, deps, told, own } = setup(1000);
    try {
      const old = {
        repo: 'lsm/a',
        number: 1,
        title: 'Old',
        branch: 'b1',
        head: 'head1',
        state: 'merged' as const,
        closedAt: 500,
      };
      ledger.replace('lsm/a', [old], 1100);
      own(1);
      db.exec(
        'ALTER TABLE pack_coding_pr_ledger DROP COLUMN terminal_event_json; DROP TABLE pack_coding_pr_event_state'
      );
      createCodingPackTables(db, 2000);
      createCodingPackTables(db, 9000);
      expect(db.prepare('SELECT activated_at FROM pack_coding_pr_event_state').get()).toEqual({
        activated_at: 2000,
      });
      await deliverCodingPrEvents(events, [], deps);
      expect(told).toHaveLength(0);
      ledger.replace('lsm/a', [old, { ...old, number: 2, closedAt: 2500 }], 3000);
      own(2);
      await deliverCodingPrEvents(events, [], deps);
      expect(told).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('a failed durable intent write rolls back the terminal state observation', async () => {
    const { db, ledger, cycle, own, told } = setup();
    try {
      await cycle(response([node(1)]), 100);
      own(1);
      const terminal = {
        repo: 'lsm/a',
        number: 1,
        title: 'T',
        branch: 'b1',
        head: 'head1abc',
        state: 'closed' as const,
        closedAt: 150,
      };
      db.exec(
        "CREATE TRIGGER reject_terminal BEFORE UPDATE ON pack_coding_pr_ledger WHEN NEW.terminal_event_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic intent failure'); END"
      );
      expect(() => ledger.replace('lsm/a', [terminal], 200)).toThrow('synthetic intent failure');
      expect(ledger.list()[0].state).not.toBe('closed');
      expect(told).toHaveLength(0);
      db.exec('DROP TRIGGER reject_terminal');
      await cycle(
        response([], [node(1, { state: 'CLOSED', closedAt: new Date(150).toISOString() })]),
        300
      );
      expect(told).toHaveLength(1);
    } finally {
      db.close();
    }
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

  test('a changes-requested transition survives a restart between the ledger write and delivery', async () => {
    const { db, ledger, deps, told, cycle, own } = setup();
    try {
      await cycle(response([node(188)]), 100);
      own(188);
      const requested = response([node(188, { reviewDecision: 'CHANGES_REQUESTED' })]);
      await reconcileCodingPrLedger(ledger, ['lsm/a'], async () => requested, 200);
      await deliverCodingPrEvents(new CodingPrEventRepository(db), [], deps);
      await cycle(requested, 300);
      expect(told.map((item) => item.key)).toEqual([
        'neo-pr-event:lsm/a#188:head188abc:changes_requested',
      ]);
    } finally {
      db.close();
    }
  });

  test('an owner cleared during delivery skips that PR and the sweep finishes', async () => {
    const { db, ledger, deps, told, cycle, own } = setup();
    try {
      await cycle(response([node(1), node(2)]), 100);
      own(1);
      own(2);
      await reconcileCodingPrLedger(
        ledger,
        ['lsm/a'],
        async () => response([node(1, {}, 'FAILURE'), node(2, {}, 'FAILURE')]),
        200
      );
      await deliverCodingPrEvents(new CodingPrEventRepository(db), [], {
        ...deps,
        tell: async (ref, key, text) => {
          db.prepare('UPDATE pack_coding_pr_ledger SET owner = NULL WHERE number = 2').run();
          return deps.tell(ref, key, text);
        },
      });
      expect(told.map((item) => item.key)).toEqual(['neo-pr-event:lsm/a#1:head1abc:failing']);
    } finally {
      db.close();
    }
  });

  test('an event skipped because its PR has no owner is logged with the PR and event', async () => {
    const { db, told, cycle } = setup();
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      await cycle(response([node(188)]), 100);
      await cycle(response([node(188, {}, 'FAILURE')]), 200);
      expect(told).toEqual([]);
      expect(warn.mock.calls.map((call) => call[0])).toContain(
        'PR event neo-pr-event:lsm/a#188:head188abc:failing skipped: lsm/a#188 has no owner'
      );
    } finally {
      warn.mockRestore();
      db.close();
    }
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
      'lsm/a#3 "T" has passing review and CI on head abcdef1. Complete all required merge gates, re-read the head, then squash-merge manually with --match-head-commit and the full approved head SHA.'
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
