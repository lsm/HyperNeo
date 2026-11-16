import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Provider } from '@hyperneo/shared/provider';
import { NEO_ATTENTION_KINDS } from '../../../../src/lib/neo/attention/decide.ts';
import { createNeoAttentionSweep } from '../../../../src/lib/neo/attention/sweep.ts';
import {
  createNeoAttention,
  neoAttentionDelivery,
} from '../../../../src/lib/neo/attention/tell.ts';
import {
  DEFAULT_ON_HOLD,
  type HeldLine,
  onLineHeld,
} from '../../../../src/lib/neo/packs/model-routing/held.ts';
import { createModelRoutingPack } from '../../../../src/lib/neo/packs/model-routing/pack.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const MINUTE = 60_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');
const HELD = { provider: 'anthropic', model: 'opus', harness: 'hyperneo' };
const OTHER = { provider: 'kimi', model: 'k2', harness: 'hyperneo' };
const usable = { ranked: [{ line: OTHER }], skipped: [], exhausted: false };
const hold = (
  sinceMinutes: number,
  resetMinutes: number,
  reason: HeldLine['reason'] = 'limit'
) => ({
  line: HELD,
  reason,
  since: NOW - sinceMinutes * MINUTE,
  retryAt: NOW + resetMinutes * MINUTE,
});

describe('onLineHeld', () => {
  test('a hold already told waits, and a new hold on the same line tells again', () => {
    const held = hold(31, 5);
    expect(
      onLineHeld({
        hold: held,
        rules: DEFAULT_ON_HOLD,
        ranking: usable,
        now: NOW,
        told: held.since,
      })
    ).toEqual({ action: 'wait' });
    expect(
      onLineHeld({
        hold: held,
        rules: DEFAULT_ON_HOLD,
        ranking: usable,
        now: NOW,
        told: held.since - 60 * MINUTE,
      })
    ).toEqual({ action: 'tellNeo', exhausted: false });
  });

  test('a short limit hold waits', () => {
    expect(
      onLineHeld({ hold: hold(10, 10), rules: DEFAULT_ON_HOLD, ranking: usable, now: NOW })
    ).toEqual({ action: 'wait' });
  });

  test('a limit hold past afterMinutes, or with a reset further away, tells Neo', () => {
    for (const held of [hold(31, 5), hold(1, 120)])
      expect(onLineHeld({ hold: held, rules: DEFAULT_ON_HOLD, ranking: usable, now: NOW })).toEqual(
        { action: 'tellNeo', exhausted: false }
      );
  });

  test('overloaded follows onHold: it waits by default and tells when a rule says move', () => {
    const overloaded = hold(120, 5, 'overloaded');
    expect(
      onLineHeld({ hold: overloaded, rules: DEFAULT_ON_HOLD, ranking: usable, now: NOW })
    ).toEqual({ action: 'wait' });
    expect(
      onLineHeld({
        hold: overloaded,
        rules: [{ reason: 'overloaded', action: 'move', afterMinutes: 60 }],
        ranking: usable,
        now: NOW,
      })
    ).toEqual({ action: 'tellNeo', exhausted: false });
  });

  test('a rule for the held line beats the rule for its reason', () => {
    expect(
      onLineHeld({
        hold: hold(1, 5),
        rules: [
          { reason: 'limit', action: 'wait', afterMinutes: 0 },
          {
            reason: 'limit',
            line: { provider: 'anthropic', model: 'opus' },
            action: 'move',
            afterMinutes: 0,
          },
        ],
        ranking: usable,
        now: NOW,
      })
    ).toEqual({ action: 'tellNeo', exhausted: false });
  });

  test('a waiting hold with no other usable line still tells Neo it is stuck', () => {
    expect(
      onLineHeld({
        hold: hold(1, 5, 'overloaded'),
        rules: DEFAULT_ON_HOLD,
        ranking: {
          ranked: [],
          skipped: [{ line: OTHER, reason: 'not signed in' }],
          exhausted: true,
        },
        now: NOW,
      })
    ).toEqual({ action: 'tellNeo', exhausted: true });
  });
});

describe('the attention sweep with model-routing on', () => {
  let db: Database;
  let sweep: (now: number) => Promise<void>;
  let whileRanking = () => {};
  let signedIn = true;
  let authReads = 0;
  let covered = false;
  let neo: string | null = 'neo:root';
  let thinking: string | undefined;

  const wakes = () =>
    (
      db.prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox'").all() as {
        payload: string;
      }[]
    ).map((row) => String(JSON.parse(row.payload).message.message.content));

  const heldTodo = (
    sinceMinutes: number,
    status = 'active',
    retryAt: number | null = NOW + 10 * MINUTE,
    reason = 'limit',
    n = 1,
    extra: Record<string, unknown> = {}
  ) => {
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const todo = store.addTodo(
      `todo-${n}`,
      'ask-1',
      {
        title: 'Ship it',
        doneWhen: 'Shipped',
        check: null,
        named: null,
        instruction: 'Ship the change.',
        approvedAt: NOW,
        dependsOn: [],
      },
      NOW
    );
    const ref = { adapter: 'hyperneo', id: `worker-${n}` };
    sessions.create(todo.id, { verb: 'send', ref });
    sessions.recordRef(todo.id, ref, NOW);
    store.updateTodo(todo, { state: 'doing', startedAt: NOW }, NOW);
    sessions.recordNudge(todo.id, { since: NOW, nudges: 0, live: 'running' });
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, processing_state)
       VALUES (?, 't', '/w', '2026-11-16', '2026-11-16', ?, ?, '{}', ?)`
    ).run(
      ref.id,
      status,
      JSON.stringify({ provider: 'anthropic', model: 'opus', thinkingLevel: thinking }),
      JSON.stringify({
        status: 'rate_limit_cooldown',
        retryCount: 0,
        maxRetries: 0,
        ...(retryAt === null ? {} : { retryAt }),
        reason,
        since: NOW - sinceMinutes * MINUTE,
        ...extra,
      })
    );
  };

  beforeEach(() => {
    db = new Database(':memory:');
    whileRanking = () => {};
    signedIn = true;
    authReads = 0;
    covered = false;
    neo = 'neo:root';
    thinking = undefined;
    runMigrations(db, () => {});
    createTables(db);
    new NeoAskTodoRepository(db).openAsk({
      id: 'ask-1',
      title: 'Cache layer',
      request: 'Build the cache layer',
      sessionId: 'neo:root',
      projectId: null,
      originMessageId: null,
      createdAt: NOW,
    });
    db.prepare(
      `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
       VALUES ('model-routing', 'global', '', 'routes', ?, 'human', 1)`
    ).run(JSON.stringify([{ kind: 'general', lines: [HELD, OTHER] }]));
    sweep = boot();
  });
  afterEach(() => db.close());

  const boot = (
    wrap: (
      wake: (uuid: string, text: string) => Promise<boolean>
    ) => (uuid: string, text: string) => Promise<boolean> = (wake) => wake,
    read: () => { covered: boolean; latestReportAt: null } = () => ({
      covered,
      latestReportAt: null,
    })
  ) => {
    const pack = createModelRoutingPack({
      database: () => db,
      provider: () =>
        ({
          isAvailable: async () => true,
          getAuthStatus: async () => {
            authReads += 1;
            whileRanking();
            return { isAuthenticated: signedIn };
          },
        }) as unknown as Provider,
      now: () => NOW,
    });
    const delivery = neoAttentionDelivery(
      db,
      () => neo,
      () => false
    );
    return createNeoAttentionSweep({
      sessions: new NeoTodoSessionRepository(db),
      packs: () => [pack],
      limits: () => ({ running: 6, perGroup: 3 }),
      scan: (now, waiting) => pack.attention!.scan!(now, waiting),
      tell: createNeoAttention({
        kinds: () => [...NEO_ATTENTION_KINDS, ...pack.attention!.kinds],
        read,
        ...delivery,
        wake: wrap(delivery.wake),
        dropped: () => {},
      }),
      failed: (_event, error) => {
        throw error;
      },
    });
  };

  test('a short limit hold on a todo’s worker tells Neo nothing', async () => {
    heldTodo(10);
    await sweep(NOW);
    expect(wakes()).toEqual([]);
  });

  test('a long limit hold tells Neo once, with the usable lines', async () => {
    heldTodo(31);
    await sweep(NOW);
    await sweep(NOW + 5 * MINUTE);
    expect(wakes()).toEqual([
      'Todo "Ship it" (todo-1) is held on anthropic opus via hyperneo (limit) since 2026-11-16T11:29:00.000Z. Usable lines, best first: kimi k2 via hyperneo. Decide whether it waits or moves.',
    ]);
  });

  test('a long hold with no known reset is measured from its start and told once', async () => {
    heldTodo(31, 'active', null);
    await sweep(NOW);
    await sweep(NOW + 5 * MINUTE);
    expect(wakes()).toEqual([
      'Todo "Ship it" (todo-1) is held on anthropic opus via hyperneo (limit) since 2026-11-16T11:29:00.000Z. Usable lines, best first: kimi k2 via hyperneo. Decide whether it waits or moves.',
    ]);
  });

  test('a hold that ends while the lines are ranked tells Neo nothing', async () => {
    heldTodo(31);
    whileRanking = () =>
      db
        .prepare(`UPDATE sessions SET processing_state = '{"status":"idle"}' WHERE id = 'worker-1'`)
        .run();
    await sweep(NOW);
    expect(wakes()).toEqual([]);
  });

  test('a short overloaded hold on the only line its route lists tells Neo it is stuck, once', async () => {
    db.prepare(
      `UPDATE neo_pack_preferences SET value_json = ? WHERE pack = 'model-routing' AND key = 'routes'`
    ).run(JSON.stringify([{ kind: 'general', lines: [HELD] }]));
    heldTodo(1, 'active', NOW + 5 * MINUTE, 'overloaded');
    await sweep(NOW);
    await sweep(NOW + MINUTE);
    expect(wakes()).toEqual([
      'Todo "Ship it" (todo-1) is held on anthropic opus via hyperneo (overloaded) since 2026-11-16T11:59:00.000Z. No other line is usable for it. Decide whether it waits or moves.',
    ]);
  });

  test('a hold is told once even when its usable lines change', async () => {
    heldTodo(31);
    await sweep(NOW);
    signedIn = false;
    await sweep(NOW + 5 * MINUTE);
    signedIn = true;
    await sweep(NOW + 10 * MINUTE);
    expect(wakes()).toHaveLength(1);
  });

  test('a hold under a covering card is told once the card clears', async () => {
    heldTodo(31);
    covered = true;
    await sweep(NOW);
    expect(wakes()).toEqual([]);
    covered = false;
    await sweep(NOW + 5 * MINUTE);
    await sweep(NOW + 10 * MINUTE);
    expect(wakes()).toHaveLength(1);
  });

  test('a hold found while Neo has no session is told once it has one', async () => {
    heldTodo(31);
    neo = null;
    await sweep(NOW);
    expect(wakes()).toEqual([]);
    neo = 'neo:root';
    await sweep(NOW + 5 * MINUTE);
    await sweep(NOW + 10 * MINUTE);
    expect(wakes()).toHaveLength(1);
  });

  test('an onHold rule naming the held line with its effort applies to the worker', async () => {
    thinking = 'think24k';
    db.prepare(
      `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
       VALUES ('model-routing', 'global', '', 'onHold', ?, 'human', 1)`
    ).run(
      JSON.stringify([
        { reason: 'limit', line: { ...HELD, effort: 'high' }, action: 'move', afterMinutes: 0 },
      ])
    );
    heldTodo(5);
    await sweep(NOW);
    expect(wakes()).toHaveLength(1);
  });

  test('a daemon stopped before the notice is queued still tells the hold after it restarts', async () => {
    heldTodo(31);
    let reached = () => {};
    const stopped = new Promise<void>((resolve) => {
      reached = resolve;
    });
    void boot(() => () => {
      reached();
      return new Promise<boolean>(() => {});
    })(NOW);
    await stopped;
    expect(wakes()).toEqual([]);
    await boot()(NOW + 5 * MINUTE);
    expect(wakes()).toHaveLength(1);
  });

  test('a daemon stopped after the notice is queued tells the hold once after it restarts with new text', async () => {
    heldTodo(31);
    let reached = () => {};
    const stopped = new Promise<void>((resolve) => {
      reached = resolve;
    });
    void boot((wake) => async (uuid, text) => {
      await wake(uuid, text);
      reached();
      return new Promise<boolean>(() => {});
    })(NOW);
    await stopped;
    expect(wakes()).toHaveLength(1);
    signedIn = false;
    await boot()(NOW + 5 * MINUTE);
    await boot()(NOW + 10 * MINUTE);
    expect(wakes()).toHaveLength(1);
  });

  test('a hold whose attention read fails is told on a later sweep', async () => {
    heldTodo(31);
    await expect(
      boot(undefined, () => {
        throw new Error('read failed');
      })(NOW)
    ).rejects.toThrow('read failed');
    await sweep(NOW + 5 * MINUTE);
    expect(wakes()).toHaveLength(1);
  });

  test('two overlapping sweeps that render different text tell one hold once', async () => {
    heldTodo(31);
    whileRanking = () => {
      signedIn = !signedIn;
    };
    await Promise.all([sweep(NOW), sweep(NOW)]);
    expect(wakes()).toHaveLength(1);
  });

  test('a line whose provider is signed out is named as not signed in', async () => {
    signedIn = false;
    heldTodo(31);
    await sweep(NOW);
    expect(wakes()).toEqual([
      'Todo "Ship it" (todo-1) is held on anthropic opus via hyperneo (limit) since 2026-11-16T11:29:00.000Z. No other line is usable for it. Not usable: kimi k2 via hyperneo (not signed in). Decide whether it waits or moves.',
    ]);
  });

  test('a hold whose reset has passed is stale and tells Neo nothing', async () => {
    heldTodo(31, 'active', NOW - MINUTE);
    await sweep(NOW);
    expect(wakes()).toEqual([]);
  });

  test('a sign-in hold past its retry time still waits on the human and is told once', async () => {
    heldTodo(31, 'active', NOW - 26 * MINUTE, 'login');
    await sweep(NOW);
    await sweep(NOW + 5 * MINUTE);
    expect(wakes()).toEqual([
      'Todo "Ship it" (todo-1) is held on anthropic opus via hyperneo (login) since 2026-11-16T11:29:00.000Z. Usable lines, best first: kimi k2 via hyperneo. Decide whether it waits or moves.',
    ]);
  });

  test('a limit hold waiting for a manual retry is live and told once', async () => {
    heldTodo(31, 'active', NOW - MINUTE, 'limit', 1, { manualRetry: true });
    await sweep(NOW);
    await sweep(NOW + 5 * MINUTE);
    expect(wakes()).toHaveLength(1);
  });

  test('two todos held on the same line are ranked once per sweep', async () => {
    heldTodo(31, 'active', NOW + 10 * MINUTE, 'limit', 1);
    heldTodo(31, 'active', NOW + 10 * MINUTE, 'limit', 2);
    await sweep(NOW);
    expect([wakes().length, authReads]).toEqual([2, 1]);
  });

  test('a hold left on an archived worker tells Neo nothing', async () => {
    heldTodo(31, 'archived');
    await sweep(NOW);
    expect(wakes()).toEqual([]);
  });
});
