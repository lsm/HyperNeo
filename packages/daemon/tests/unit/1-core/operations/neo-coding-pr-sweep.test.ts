import { describe, expect, test } from 'bun:test';
import {
  CodingPrSweepRepository,
  planCodingPrNudge,
  sweepCodingPrs,
} from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const MIN = 60_000;
const owner = { adapter: 'claude-desktop', id: 'worker-1' };

function setup() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const insert = (number: number, state: string, ownerRef: unknown = owner) =>
    db
      .prepare(
        `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, owner, read_at)
         VALUES ('lsm/hyperneo', ?, 'Fix login', 'b', 'abc1234def', ?, 0, ?, 0)`
      )
      .run(number, state, ownerRef ? JSON.stringify(ownerRef) : null);
  const told: { ref: unknown; key: string; text: string }[] = [];
  const woken: { key: string; text: string }[] = [];
  let reachable = true;
  const deps = {
    tell: async (ref: unknown, key: string, text: string) => {
      if (!reachable) return false;
      told.push({ ref, key, text });
      return true;
    },
    wake: async (key: string, text: string) => {
      woken.push({ key, text });
      return true;
    },
  };
  const repo = new CodingPrSweepRepository(db);
  const at = async (minutes: number) => {
    db.prepare('UPDATE pack_coding_pr_ledger SET read_at = ?').run(minutes * MIN);
    await sweepCodingPrs(repo, deps, minutes * MIN);
  };
  return {
    db,
    insert,
    told,
    woken,
    at,
    unreachable: () => {
      reachable = false;
    },
  };
}

describe('PR sweep ladder', () => {
  test('an idle approved PR tells its owner at 20 and 40 minutes, then wakes Neo once', async () => {
    const { insert, told, woken, at, db } = setup();
    insert(7, 'approved_green');
    for (const minutes of [19, 20, 25, 39, 40, 45, 59, 60, 65, 120]) await at(minutes);
    expect(told.map((item) => item.key)).toEqual([
      'neo-pr-sweep:lsm/hyperneo#7:abc1234def:approved_green:1',
      'neo-pr-sweep:lsm/hyperneo#7:abc1234def:approved_green:2',
    ]);
    expect(told[0]).toMatchObject({ ref: owner });
    expect(told[0].text).toBe(
      'lsm/hyperneo#7 "Fix login" has been approved green for 20 min on head abc1234. Merge it now with a manual squash on this head.'
    );
    expect(woken).toHaveLength(1);
    expect(woken[0].text).toContain('was reminded 2 times without progress');
    db.close();
  });

  test('progress resets the clock and the count', async () => {
    const { insert, told, at, db } = setup();
    insert(7, 'failing');
    await at(30);
    expect(told).toHaveLength(1);
    db.prepare(
      "UPDATE pack_coding_pr_ledger SET state = 'waiting_review', state_since = ?, nudges = 0"
    ).run(35 * MIN);
    await at(60);
    expect(told).toHaveLength(1);
    await at(65);
    expect(told.map((item) => item.key.split(':').slice(-2).join(':'))).toEqual([
      'failing:1',
      'waiting_review:1',
    ]);
    db.close();
  });

  test('an unowned, draft or stale-read PR is never nudged', async () => {
    const { insert, told, woken, db } = setup();
    insert(1, 'approved_green', null);
    insert(2, 'draft');
    insert(3, 'approved_green');
    await sweepCodingPrs(
      new CodingPrSweepRepository(db),
      {
        tell: async () => {
          told.push({ ref: null, key: 'x', text: 'x' });
          return true;
        },
        wake: async () => true,
      },
      300 * MIN
    );
    expect(told).toEqual([]);
    expect(woken).toEqual([]);
    db.close();
  });

  test('an owner that cannot be reached wakes Neo once instead', async () => {
    const { insert, told, woken, at, unreachable, db } = setup();
    insert(7, 'dirty');
    unreachable();
    await at(20);
    await at(40);
    expect(told).toEqual([]);
    expect(woken).toHaveLength(1);
    expect(woken[0].text).toContain('could not be reached');
    db.close();
  });
});

describe('planCodingPrNudge', () => {
  test('uses each state deadline', () => {
    const row = (state: string, minutes: number) =>
      planCodingPrNudge(
        {
          repo: 'r/r',
          number: 1,
          title: 't',
          head: 'h',
          state: state as never,
          stateSince: 0,
          readAt: minutes * MIN,
          nudges: 0,
          owner,
        },
        minutes * MIN
      );
    expect(row('approved_pending', 59)).toBeNull();
    expect(row('approved_pending', 60)).toEqual({ kind: 'remind', nudges: 1 });
    expect(row('waiting_review', 29)).toBeNull();
    expect(row('waiting_review', 30)).toEqual({ kind: 'remind', nudges: 1 });
    expect(row('merged', 600)).toBeNull();
  });
});
