import { createNeoPackPreferencesTable } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { describe, expect, test } from 'bun:test';
import {
  CodingPrSweepRepository,
  codingFindingsText,
  codingPrNudgeText,
  planCodingPrNudge,
  sweepCodingPrs,
} from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CODING_ATTENTION_KINDS } from '../../../../src/lib/neo/packs/coding/attention.ts';
import type { NeoAttentionEvent } from '../../../../src/lib/neo/attention/decide.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { neoAttentionNotes } from '../../helpers/neo-attention-notes.ts';
import { planCodingPrEvent } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { SendWorkInputSchema } from '../../../../src/lib/drivers/work-operations.ts';

const MIN = 60_000;
const owner = { adapter: 'claude-desktop', id: 'worker-1' };

function setup() {
  const db = new Database(':memory:');
  createNeoPackPreferencesTable(db);
  createCodingPackTables(db);
  const insert = (number: number, state: string, ownerRef: unknown = owner) =>
    db
      .prepare(
        `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, owner, read_at)
         VALUES ('lsm/hyperneo', ?, 'Fix login', 'b', 'abc1234def', ?, 0, ?, 0)`
      )
      .run(number, state, ownerRef ? JSON.stringify(ownerRef) : null);
  const told: { ref: unknown; key: string; text: string; findings?: readonly string[] }[] = [];
  const woken: { kind: string; subject: string; text: string }[] = [];
  let reachable = true;
  const attend = async (event: NeoAttentionEvent) => {
    woken.push({ kind: event.kind, subject: event.subject.id, text: String(event.facts.text) });
    return true;
  };
  const deps = {
    host: 'github.com',
    tell: async (
      ref: unknown,
      key: string,
      text: string,
      _pr?: string,
      findings?: readonly string[]
    ) => {
      if (!reachable) return false;
      told.push({ ref, key, text, ...(findings?.length ? { findings } : {}) });
      return true;
    },
    attend,
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
    attend,
    at,
    unreachable: () => {
      reachable = false;
    },
  };
}

describe('PR sweep ladder', () => {
  test('asks Neo to assign an author and review for unowned requested changes', async () => {
    const { insert, told, woken, at, db } = setup();
    insert(7, 'changes_requested', null);
    await at(20);
    expect(told).toEqual([]);
    expect(woken).toHaveLength(1);
    expect(woken[0].text).toContain('Assign an author');
    expect(woken[0].text).toContain('cross-model review');
    db.close();
  });
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
      'lsm/hyperneo#7 "Fix login" has been approved and green for 20 min on head abc1234. Complete all required merge gates, re-read the head, then squash-merge manually with --match-head-commit and the full approved head SHA.'
    );
    expect(woken).toHaveLength(1);
    expect(woken[0].text).toBe(
      'PR sweep: lsm/hyperneo#7 "Fix login" has been approved and green since 1970-01-01T00:00:00.000Z on head abc1234, and its owner claude-desktop:worker-1 could not be reached or has made no progress. Reassign it to a free session. If its owner is gone, complete the required merge gates before a SHA-pinned manual merge.'
    );
    db.close();
  });

  test('an escalation told before its ledger mark was written is not told again', async () => {
    const { insert, db } = setup();
    runMigrations(db, () => {});
    createTables(db);
    const notes = neoAttentionNotes(
      db,
      new NeoAskTodoRepository(db),
      () => {},
      CODING_ATTENTION_KINDS
    );
    insert(7, 'approved_green');
    for (const minutes of [60, 65]) {
      db.prepare('UPDATE pack_coding_pr_ledger SET read_at = ?, nudges = 0').run(minutes * MIN);
      await sweepCodingPrs(
        new CodingPrSweepRepository(db),
        {
          host: 'github.com',
          tell: async () => true,
          attend: async (event) => 'told' in (await notes.attend(event)),
        },
        minutes * MIN
      );
    }
    expect(notes.wakes()).toEqual([expect.stringContaining('has made no progress')]);
    db.close();
  });

  test('an unreachable owner whose escalation mark was lost is not told again on later rungs', async () => {
    const { insert, db } = setup();
    runMigrations(db, () => {});
    createTables(db);
    const notes = neoAttentionNotes(
      db,
      new NeoAskTodoRepository(db),
      () => {},
      CODING_ATTENTION_KINDS
    );
    insert(7, 'dirty');
    for (const minutes of [20, 40, 60]) {
      db.prepare('UPDATE pack_coding_pr_ledger SET read_at = ?, nudges = 0').run(minutes * MIN);
      await sweepCodingPrs(
        new CodingPrSweepRepository(db),
        {
          host: 'github.com',
          tell: async () => false,
          attend: async (event) => 'told' in (await notes.attend(event)),
        },
        minutes * MIN
      );
    }
    expect(notes.wakes()).toEqual([
      expect.stringContaining('could not be reached or has made no progress'),
    ]);
    db.close();
  });

  test('a first observation after 60 minutes does not claim reminders were sent', async () => {
    const { insert, told, woken, at, db } = setup();
    insert(7, 'approved_green');
    await at(60);
    expect(told).toEqual([]);
    expect(woken).toHaveLength(1);
    expect(woken[0].text).not.toContain('was reminded');
    db.close();
  });

  test('progress resets the clock and the count', async () => {
    const { insert, told, at, db } = setup();
    insert(7, 'failing');
    await at(20);
    expect(told).toHaveLength(1);
    db.prepare(
      "UPDATE pack_coding_pr_ledger SET state = 'waiting_review', state_since = ?, nudges = 0"
    ).run(35 * MIN);
    await at(54);
    expect(told).toHaveLength(1);
    await at(55);
    expect(told.map((item) => item.key.split(':').slice(-2).join(':'))).toEqual([
      'failing:1',
      'waiting_review:1',
    ]);
    db.close();
  });

  test('an unowned, draft or stale-read PR is never nudged', async () => {
    const { insert, told, woken, attend, db } = setup();
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
        host: 'github.com',
        attend,
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

describe('sweepCodingPrs', () => {
  test('a throwing delivery counts as unreachable and the next rows still get their reminders', async () => {
    const { insert, told, woken, attend, db } = setup();
    insert(1, 'approved_green', { adapter: 'hyperneo', id: 'broken' });
    insert(2, 'approved_green');
    db.prepare('UPDATE pack_coding_pr_ledger SET read_at = ?').run(20 * MIN);
    await sweepCodingPrs(
      new CodingPrSweepRepository(db),
      {
        tell: async (ref, key, text) => {
          if ((ref as { id: string }).id === 'broken') throw new Error('mailbox rejected');
          told.push({ ref, key, text });
          return true;
        },
        host: 'github.com',
        attend,
      },
      20 * MIN
    );
    expect(told.map((item) => item.key)).toEqual([
      'neo-pr-sweep:lsm/hyperneo#2:abc1234def:approved_green:1',
    ]);
    expect(woken.map((item) => item.text)).toEqual([expect.stringContaining('lsm/hyperneo#1')]);
    db.close();
  });
});

describe('codingPrNudgeText', () => {
  test('pending CI text never tells the owner to merge', () => {
    expect(
      codingPrNudgeText(
        {
          repo: 'lsm/open-agent-protocol',
          number: 1266,
          title: 'hub',
          head: 'abcdef1234',
          state: 'approved_pending',
          stateSince: 0,
          readAt: 0,
          nudges: 0,
          owner,
        },
        65 * MIN
      )
    ).toBe(
      'lsm/open-agent-protocol#1266 "hub" has been approved with CI still pending for 65 min on head abcdef1. CI is still running; fix it if it fails.'
    );
  });
});

describe('planCodingPrNudge', () => {
  test('uses the same 20 minute interval for every actionable state', () => {
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
    expect(row('approved_pending', 19)).toBeNull();
    expect(row('approved_pending', 20)).toEqual({ kind: 'remind', nudges: 1 });
    expect(row('waiting_review', 19)).toBeNull();
    expect(row('waiting_review', 20)).toEqual({ kind: 'remind', nudges: 1 });
    expect(row('merged', 600)).toBeNull();
    expect(row('unreviewed', 600)).toBeNull();
  });
});

describe('sweepCodingPrs cross-model review', () => {
  test('a PR waiting for a cross-model review wakes Neo once to assign a reviewer', async () => {
    const { insert, told, woken, at, db } = setup();
    insert(9, 'waiting_cross_review');
    await at(19);
    expect(woken).toEqual([]);
    await at(20);
    expect(told).toEqual([]);
    expect(woken).toEqual([
      {
        kind: 'coding.pr_sweep',
        subject: 'https://github.com/lsm/hyperneo/pull/9@abc1234def',
        text: expect.stringContaining('different model'),
      },
    ]);
    await at(60);
    expect(woken).toHaveLength(1);
    db.close();
  });
});

describe('sweepCodingPrs cross-model review without an owner', () => {
  test('an ownerless PR waiting for a cross-model review still wakes Neo once', async () => {
    const { insert, told, woken, at, db } = setup();
    insert(10, 'waiting_cross_review', null);
    await at(20);
    expect(told).toEqual([]);
    expect(woken).toEqual([
      {
        kind: 'coding.pr_sweep',
        subject: 'https://github.com/lsm/hyperneo/pull/10@abc1234def',
        text: expect.stringContaining('different model'),
      },
    ]);
    await at(60);
    expect(woken).toHaveLength(1);
    db.close();
  });
});

describe('sweepCodingPrs failed cross-model review', () => {
  test('the author is reminded with the review findings, and Neo is not asked for another reviewer', async () => {
    const { insert, told, woken, at, db } = setup();
    insert(11, 'changes_requested');
    const url = 'https://github.com/lsm/hyperneo/pull/11';
    db.prepare('INSERT INTO pack_coding_stage_heads (url, head, observed_at) VALUES (?, ?, 0)').run(
      url,
      'abc1234def'
    );
    db.prepare(
      'INSERT INTO pack_coding_stage_facts (url, head, stage, fact_json) VALUES (?, ?, ?, ?)'
    ).run(
      url,
      'abc1234def',
      'review',
      JSON.stringify({
        url,
        head: 'abc1234def',
        stage: 'review',
        actor: { kind: 'agent', id: 'reviewer', model: 'gpt-6.1-sol', harness: 'Codex' },
        verdict: 'fail',
        acceptanceContract: 'contract',
        evidence: ['P1 the retry loop never stops.'],
      })
    );
    await at(20);
    expect(told).toEqual([
      {
        ref: owner,
        key: 'neo-pr-sweep:lsm/hyperneo#11:abc1234def:changes_requested:review:1',
        text: 'lsm/hyperneo#11 "Fix login" has been waiting on requested changes for 20 min on head abc1234. Address the review and push.',
        findings: ['P1 the retry loop never stops.'],
      },
    ]);
    expect(woken).toEqual([]);
    db.close();
  });
});

describe('PR delivery keys', () => {
  test('a long repository name still gives keys the send accepts, one per head, state, review and rung', async () => {
    const { db, told, at } = setup();
    const repo = `${'o'.repeat(39)}/${'r'.repeat(78)}`;
    const head = 'f'.repeat(40);
    const url = `https://github.com/${repo}/pull/123`;
    db.prepare(
      `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, owner, read_at)
       VALUES (?, 123, 'Fix login', 'b', ?, 'changes_requested', 0, ?, 0)`
    ).run(repo, head, JSON.stringify(owner));
    db.prepare('INSERT INTO pack_coding_stage_heads (url, head, observed_at) VALUES (?, ?, 0)').run(
      url,
      head
    );
    db.prepare(
      'INSERT INTO pack_coding_stage_facts (url, head, stage, fact_json) VALUES (?, ?, ?, ?)'
    ).run(
      url,
      head,
      'review',
      JSON.stringify({
        url,
        head,
        stage: 'review',
        actor: { kind: 'agent', id: 'reviewer', model: 'gpt-6.1-sol', harness: 'Codex' },
        verdict: 'fail',
        acceptanceContract: 'contract',
        evidence: ['P1 the retry loop never stops.'],
      })
    );
    await at(20);
    await at(40);
    const row = {
      repo,
      number: 123,
      title: 'Fix login',
      branch: 'b',
      head,
      closedAt: null,
      from: 'waiting_cross_review' as const,
    };
    const keys = [
      ...told.map((item) => item.key),
      planCodingPrEvent({ ...row, state: 'changes_requested', findings: ['P1'] })!.key,
      planCodingPrEvent({ ...row, state: 'changes_requested' })!.key,
      planCodingPrEvent({ ...row, head: 'e'.repeat(40), state: 'changes_requested' })!.key,
      planCodingPrEvent({ ...row, state: 'failing' })!.key,
    ];
    expect(told).toHaveLength(2);
    for (const key of keys)
      expect(SendWorkInputSchema.shape.idempotencyKey.safeParse(key).success).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    db.close();
  });

  test('a merged or closed PR is announced without review findings', () => {
    for (const state of ['merged', 'closed'] as const) {
      const event = planCodingPrEvent({
        repo: 'lsm/hyperneo',
        number: 1,
        title: 'Fix login',
        branch: 'b',
        head: 'abc1234def',
        state,
        closedAt: 1,
        findings: ['P1 the retry loop never stops.'],
        from: 'changes_requested',
      });
      expect(event).toEqual({
        key: `neo-pr-event:lsm/hyperneo#1:abc1234def:${state}`,
        text: expect.stringMatching(/^lsm\/hyperneo#1 "Fix login" was /),
      });
    }
  });
});

describe('sweepCodingPrs acknowledgement after a late review fail', () => {
  test.each([
    ['reminder', 0, 20],
    ['escalation', 2, 60],
  ] as const)(
    'a review fail recorded while its %s is in flight keeps the fresh reminders',
    async (_kind, nudges, minutes) => {
      const { db, insert } = setup();
      insert(12, 'changes_requested');
      const now = minutes * MIN;
      db.prepare('UPDATE pack_coding_pr_ledger SET nudges = ?, read_at = ?').run(nudges, now);
      const url = 'https://github.com/lsm/hyperneo/pull/12';
      db.prepare(
        'INSERT INTO pack_coding_stage_heads (url, head, observed_at) VALUES (?, ?, 0)'
      ).run(url, 'abc1234def');
      const recordFail = () =>
        new CodingPrLedgerRepository(db).recordStage(
          {
            url,
            head: 'abc1234def',
            stage: 'review',
            actor: { kind: 'agent', id: 'reviewer', model: 'gpt-6.1-sol', harness: 'Codex' },
            verdict: 'fail',
            acceptanceContract: 'contract',
            evidence: ['P1 the retry loop never stops.'],
          },
          now
        );
      const repo = new CodingPrSweepRepository(db);
      await sweepCodingPrs(
        repo,
        {
          host: 'github.com',
          tell: async () => recordFail(),
          attend: async () => recordFail(),
        },
        now
      );
      expect(repo.rows().map((row) => [row.nudges, row.stateSince, row.findings])).toEqual([
        [0, now, ['P1 the retry loop never stops.']],
      ]);
      const told: string[] = [];
      db.prepare('UPDATE pack_coding_pr_ledger SET read_at = ?').run(now + 20 * MIN);
      await sweepCodingPrs(
        repo,
        {
          host: 'github.com',
          tell: async (_ref, key) => {
            told.push(key);
            return true;
          },
          attend: async () => true,
        },
        now + 20 * MIN
      );
      expect(told).toEqual(['neo-pr-sweep:lsm/hyperneo#12:abc1234def:changes_requested:review:1']);
      db.close();
    }
  );
});

describe('codingFindingsText', () => {
  test('a truncated report never splits a character in two', () => {
    const findings = ['\u{1F600}'.repeat(40)];
    const full = codingFindingsText(findings);
    const truncated = codingFindingsText(findings, full.length - 1);
    expect(truncated.length).toBeLessThan(full.length);
    for (let budget = 80; budget < full.length; budget++)
      expect(codingFindingsText(findings, budget).isWellFormed()).toBe(true);
    expect(truncated.isWellFormed()).toBe(true);
  });
});

describe('CodingPrLedgerRepository.recordStage', () => {
  test('a failed ledger refresh leaves no review fail recorded, so a retry refreshes it', () => {
    const { db, insert } = setup();
    insert(12, 'changes_requested');
    const url = 'https://github.com/lsm/hyperneo/pull/12';
    db.prepare('INSERT INTO pack_coding_stage_heads (url, head, observed_at) VALUES (?, ?, 0)').run(
      url,
      'abc1234def'
    );
    db.exec(
      "CREATE TRIGGER fail_refresh BEFORE UPDATE ON pack_coding_pr_ledger BEGIN SELECT RAISE(ABORT, 'busy'); END"
    );
    const ledger = new CodingPrLedgerRepository(db);
    const fail = () =>
      ledger.recordStage(
        {
          url,
          head: 'abc1234def',
          stage: 'review',
          actor: { kind: 'agent', id: 'reviewer', model: 'gpt-6.1-sol', harness: 'Codex' },
          verdict: 'fail',
          acceptanceContract: 'contract',
          evidence: ['P1 the retry loop never stops.'],
        },
        500
      );
    expect(fail).toThrow('busy');
    db.exec('DROP TRIGGER fail_refresh');
    expect(fail()).toBe(true);
    expect(
      db.prepare('SELECT state_since AS since FROM pack_coding_pr_ledger WHERE number = 12').get()
    ).toEqual({ since: 500 });
    db.close();
  });
});
