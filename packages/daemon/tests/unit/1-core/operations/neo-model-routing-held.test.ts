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

  const wakes = () =>
    (
      db.prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox'").all() as {
        payload: string;
      }[]
    ).map((row) => String(JSON.parse(row.payload).message.message.content));

  const heldTodo = (sinceMinutes: number, status = 'active') => {
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    store.openAsk({
      id: 'ask-1',
      title: 'Cache layer',
      request: 'Build the cache layer',
      sessionId: 'neo:root',
      projectId: null,
      originMessageId: null,
      createdAt: NOW,
    });
    const todo = store.addTodo(
      'todo-1',
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
    const ref = { adapter: 'hyperneo', id: 'worker-1' };
    sessions.create(todo.id, { verb: 'send', ref });
    sessions.recordRef(todo.id, ref, NOW);
    store.updateTodo(todo, { state: 'doing', startedAt: NOW }, NOW);
    sessions.recordNudge(todo.id, { since: NOW, nudges: 0, live: 'running' });
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, processing_state)
       VALUES ('worker-1', 't', '/w', '2026-11-16', '2026-11-16', ?, ?, '{}', ?)`
    ).run(
      status,
      JSON.stringify({ provider: 'anthropic', model: 'opus' }),
      JSON.stringify({
        status: 'rate_limit_cooldown',
        retryCount: 0,
        maxRetries: 0,
        retryAt: NOW + 10 * MINUTE,
        reason: 'limit',
        since: NOW - sinceMinutes * MINUTE,
      })
    );
  };

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.prepare(
      `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
       VALUES ('model-routing', 'global', '', 'routes', ?, 'human', 1)`
    ).run(JSON.stringify([{ kind: 'general', lines: [HELD, OTHER] }]));
    const pack = createModelRoutingPack({
      database: () => db,
      provider: () =>
        ({
          isAvailable: async () => true,
          getAuthStatus: async () => ({ isAuthenticated: true }),
        }) as unknown as Provider,
      now: () => NOW,
    });
    sweep = createNeoAttentionSweep({
      sessions: new NeoTodoSessionRepository(db),
      packs: () => [pack],
      limits: () => ({ running: 6, perGroup: 3 }),
      scan: (now) => pack.attention!.scan!(now),
      tell: createNeoAttention({
        kinds: () => [...NEO_ATTENTION_KINDS, ...pack.attention!.kinds],
        read: () => ({ covered: false, latestReportAt: null }),
        ...neoAttentionDelivery(
          db,
          () => 'neo:root',
          () => false
        ),
        dropped: () => {},
      }),
      failed: (_event, error) => {
        throw error;
      },
    });
  });
  afterEach(() => db.close());

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

  test('a hold left on an archived worker tells Neo nothing', async () => {
    heldTodo(31, 'archived');
    await sweep(NOW);
    expect(wakes()).toEqual([]);
  });
});
