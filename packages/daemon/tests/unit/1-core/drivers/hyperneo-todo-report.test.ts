import { readHyperneoTurnEnds } from '../../../../src/storage/hyperneo-turn-ends-read.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHyperneoAdapter } from '../../../../src/lib/drivers/hyperneo-adapter.ts';
import { readDriverFollowUp, readDriverSettlement } from '../../../../src/lib/neo/driver-work.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('HyperNeo todo reply attribution', () => {
  let db: Database;
  const receipt = { executionId: 'worker', inputId: 'todo-input' };
  const report = '  COMPLETE_TODO_REPORT 🔬\n'.repeat(800) + '\n';
  const put = (id: string, type: string, text: string, consumed: number | null) => {
    const body =
      type === 'result'
        ? { type, subtype: 'success', result: text, is_error: false }
        : { type, message: { content: [{ type: 'text', text }] } };
    db.prepare(`INSERT INTO sdk_messages(id,session_id,sdk_uuid,message_type,sdk_message,timestamp,
      send_status,consumed_seq,is_terminal) VALUES (?,'worker',?,?,?,?, 'consumed',?,?)`).run(
      id,
      id,
      type,
      JSON.stringify(body),
      new Date((consumed ?? 1) * 1000).toISOString(),
      consumed,
      type === 'result' ? 1 : 0
    );
  };
  const status = async (input = receipt, extra = {}) => {
    const adapter = createHyperneoAdapter({
      readTurnEnds: async (id, since) => readHyperneoTurnEnds(db, id, since),
      db: () => db,
      ...extra,
      machine: 'synthetic',
      searchChats: async () => [],
      handoff: async () => ({ kind: 'enqueued', id: 'synthetic' }),
      sessions: {
        create: async () => {
          throw new Error('unused');
        },
        resolveModel: async () => null,
        model: () => null,
        chooseWorktree: async () => {},
        announce: () => {},
        interrupt: () => false,
      },
      neoFolder: () => '/synthetic/neo',
      folderExists: () => true,
      makeFolder: () => {},
      homeDir: '/synthetic',
    });
    return {
      kind: 'completed' as const,
      value: await adapter.status!({ adapter: 'hyperneo', id: 'worker' }, 0, input),
    };
  };
  const settle = async (input = receipt) =>
    readDriverSettlement(
      { updatedAt: 1 },
      await status(input),
      100000,
      1000,
      true,
      'Original todo',
      input
    );
  const digest = () =>
    JSON.stringify([
      db.prepare('SELECT * FROM sdk_messages ORDER BY seq').all(),
      db.prepare('SELECT * FROM sdk_message_bodies ORDER BY seq').all(),
    ]);
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    db.prepare(`INSERT INTO sessions(id,title,created_at,last_active_at,status,config,metadata,
      processing_state,type) VALUES ('worker','Synthetic','2026-10-20','2026-10-20','active','{}','{}','{"status":"idle"}','worker')`).run();
    put('todo-input', 'user', 'Original todo instruction', 10);
  });
  afterEach(() => db.close());

  test('status awaits the reader for complete turn reports without a main SQL fallback', async () => {
    const turnEnds = [{ id: 'worker-result', at: 20000, startedAt: 10000, message: report }];
    const calls: unknown[] = [];
    const detail = await status(receipt, {
      readTurnEnds: async (id: string, since: number) => {
        calls.push([id, since]);
        await Promise.resolve();
        return turnEnds;
      },
    });
    expect(calls).toEqual([['worker', 0]]);
    expect(detail.value).toMatchObject({ ok: true, value: { turnEnds } });
  });

  test('reader failure rejects status instead of repeating the read on main', async () => {
    await expect(
      status(receipt, {
        readTurnEnds: async () => {
          throw new Error('reader unavailable');
        },
      })
    ).rejects.toThrow('reader unavailable');
  });

  test.each(['', report])(
    'exposes a complete explicit SDK turn end, including silence: %s',
    async (message) => {
      put('terminal', 'result', message, 20);
      const detail = await status();
      expect(detail.value).toMatchObject({
        ok: true,
        value: {
          turnEnds: [{ id: expect.any(String), at: 20000, message }],
        },
      });
    }
  );

  test('an empty SDK result carries its actual final assistant message', async () => {
    put('assistant', 'assistant', report, null);
    put('terminal', 'result', '', 20);
    expect((await status()).value).toMatchObject({
      ok: true,
      value: {
        turnEnds: [{ message: report }],
      },
    });
  });

  test('internal compaction and intercepted recovery records cannot replace a final message', async () => {
    put('assistant', 'assistant', report, null);
    put('intercepted', 'result', 'INTERNAL RECOVERY', 15);
    db.prepare("UPDATE sdk_messages SET recovery_intercepted=1 WHERE id='intercepted'").run();
    put('compaction', 'assistant', 'INTERNAL COMPACTION', null);
    db.prepare("UPDATE sdk_messages SET internal_compaction_turn=1 WHERE id='compaction'").run();
    put('terminal', 'result', '', 20);
    expect((await status()).value).toMatchObject({
      ok: true,
      value: {
        turnEnds: [{ message: report }],
      },
    });
  });

  test('mid-turn human input does not sever the complete assistant report or borrow a later turn', async () => {
    put('mid-turn', 'user', 'Human clarification', 15);
    put('report', 'assistant', report, null);
    put('terminal', 'result', '', 20);
    put('later-input', 'user', 'Separate later task', 30);
    put('later-result', 'result', 'UNRELATED_LATER_REPORT', 40);
    const original = digest();
    const settled = await settle();
    expect(settled?.status).toBe('reported');
    expect(settled?.report).toBe(`Agent: ${report}`);
    expect(settled?.report).not.toContain('UNRELATED_LATER_REPORT');
    expect(digest()).toBe(original);
  });

  test('a todo injected mid-turn does not claim assistant text written before its input', async () => {
    db.prepare("UPDATE sdk_messages SET seq=100 WHERE id='todo-input'").run();
    db.prepare(`INSERT INTO sdk_messages(seq,id,session_id,message_type,sdk_message,timestamp)
      VALUES (99,'earlier-progress','worker','assistant',?,?)`).run(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'UNRELATED_BEFORE_TODO' }] },
      }),
      new Date(1000).toISOString()
    );
    put('report', 'assistant', 'Own final report', null);
    put('terminal', 'result', '', 20);
    expect((await settle())?.report).toBe('Agent: Own final report');
  });

  test('inputs acknowledged at the same terminal watermark share its verified reply', async () => {
    put('mid-turn', 'user', 'Consumed with the todo', 10);
    put('report', 'assistant', 'Shared turn report', null);
    put('terminal', 'result', '', 10);
    expect((await settle())?.report).toBe('Agent: Shared turn report');
  });

  test('paging remains inside the consumed turn and preserves assistant ordering', async () => {
    put('previous-result', 'result', 'PREVIOUS_TURN', 5);
    for (let n = 0; n < 30; n++) put(`part-${n}`, 'assistant', `Part ${n}`, null);
    put('terminal', 'result', '', 20);
    put('other', 'user', 'Next turn', 30);
    put('other-result', 'result', 'LATER_TURN', 40);
    const expected = Array.from({ length: 30 }, (_, n) => `Agent: Part ${n}`).join('\n\n');
    expect((await settle())?.report).toBe(expected);
  });

  test('long result-only reports remain complete rather than using exchange excerpts', async () => {
    put('terminal', 'result', report, 20);
    expect((await settle())?.report).toBe(`Agent: ${report}`);
  });

  test('an absent terminal is incomplete evidence, never proof of no written reply', async () => {
    put('progress', 'assistant', 'Still writing the report', null);
    const settled = await settle();
    expect(settled?.report).toMatch(/incomplete|unavailable/i);
    expect(settled?.report).not.toContain('without a written reply');
  });

  test('a missing acknowledged input cannot borrow the session latest reply', async () => {
    put('later-result', 'result', 'UNRELATED_LATEST_REPORT', 40);
    expect(await settle({ ...receipt, inputId: 'missing' })).toBeNull();
    expect(
      readDriverFollowUp(await status({ ...receipt, inputId: 'missing' }), 0, {
        inputBefore: 0,
        opening: 'Original',
        receipt: { ...receipt, inputId: 'missing' },
      })
    ).toBeNull();
  });
});
