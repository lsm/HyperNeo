import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReadWorkOperation } from '../../../../src/lib/drivers/read-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { readWorkTurnPage } from '../../../../src/storage/work-turn-page.ts';

type Page = {
  sessionId: string;
  turns: {
    messageId: string;
    role: string;
    text: string;
    textOffset?: number;
    textComplete?: boolean;
    files?: unknown[];
  }[];
  availability: string;
  nextCursor?: Record<string, unknown>;
};

describe('authoritative work.read', () => {
  let db: Database;
  const report = '  SYNTHETIC_COMPLETE_REPORT 🔬\n'.repeat(320) + '\n';
  const put = (
    id: string,
    type: string,
    content: unknown,
    extra: {
      session?: string;
      split?: boolean;
      parent?: string;
      compact?: boolean;
      status?: string;
    } = {}
  ) => {
    const message = type === 'result' ? { type, result: content } : { type, message: { content } };
    db.prepare(`INSERT INTO sdk_messages (id,session_id,message_type,sdk_message,timestamp,parent_tool_use_id,internal_compaction_turn,send_status)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      id,
      extra.session ?? 'worker',
      type,
      JSON.stringify(extra.split ? { type } : message),
      '2026-10-20T10:00:00Z',
      extra.parent ?? null,
      extra.compact ? 1 : 0,
      extra.status ?? 'consumed'
    );
    if (extra.split)
      db.prepare(
        'INSERT INTO sdk_message_bodies (seq,sdk_message) VALUES ((SELECT seq FROM sdk_messages WHERE id=?),?)'
      ).run(id, JSON.stringify(message));
  };
  const invoke = (input: Record<string, unknown>) =>
    invokeOperation(
      createOperationRegistry([
        createReadWorkOperation({
          readTurns: (id, around, before, after, cursor) =>
            readWorkTurnPage(db, id, around, before, after, cursor),
          remote: {
            list: () => [],
            invoke: async () => {
              throw new Error('no remote in this fixture');
            },
          },
          daemonName: 'synthetic',
        }),
      ]),
      'work.read',
      input,
      { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
    );
  const page = async (input: Record<string, unknown>) => {
    const result = await invoke({ sessionId: 'worker', ...input });
    if (result.kind !== 'completed') throw new Error(JSON.stringify(result));
    expect(result.value).toMatchObject({ ok: true });
    return (result.value as { ok: true; value: Page }).value;
  };
  const digest = () =>
    createHash('sha256')
      .update(
        JSON.stringify([
          db.prepare('SELECT * FROM sdk_messages ORDER BY seq').all(),
          db.prepare('SELECT * FROM sdk_message_bodies ORDER BY seq').all(),
        ])
      )
      .digest('hex');
  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    db.exec(`CREATE TABLE message_search_content (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT,
      message_id TEXT, session_id TEXT, message_type TEXT, body TEXT, timestamp INTEGER)`);
    for (const id of ['worker', 'other'])
      db.prepare(
        `INSERT INTO sessions (id,title,created_at,last_active_at,status,config,metadata) VALUES (?,?,'2026-10-20','2026-10-20','active','{}','{}')`
      ).run(id, id);
  });
  afterEach(() => db.close());

  test('an older complete report is readable with an empty or stale pending search index', async () => {
    put('report', 'assistant', [{ type: 'text', text: report }], { split: true });
    for (let n = 0; n < 30; n++) put(`later-${n}`, 'user', `Follow-up ${n}`);
    const before = digest();
    expect((await page({ around: 'report', before: 0, after: 0 })).turns).toMatchObject([
      { messageId: 'report', text: report },
    ]);
    db.prepare(
      `INSERT INTO message_search_content(kind,source_id,message_id,session_id,message_type,body,timestamp) VALUES ('message','stale','report','worker','assistant','stale truncated summary',1)`
    ).run();
    expect((await page({ around: 'report', before: 0, after: 0 })).turns[0].text).toBe(report);
    expect(digest()).toBe(before);
  });

  test('legacy and split bodies retain visible text when a result is empty and deduplicate echoed results', async () => {
    put('human', 'user', 'Please report');
    put('legacy', 'assistant', [
      { type: 'thinking', thinking: 'HIDDEN_THINKING' },
      { type: 'text', text: report },
    ]);
    put('empty', 'result', '');
    expect(
      (await page({ before: 10, after: 0 })).turns
        .filter((t) => t.role === 'assistant')
        .map((t) => t.text)
    ).toEqual([report]);
    put('echo', 'result', report.trim());
    expect(
      (await page({ before: 10, after: 0 })).turns
        .filter((t) => t.role === 'assistant')
        .map((t) => t.text)
    ).toEqual([report]);
    expect((await page({ around: 'echo', before: 0, after: 0 })).turns.map((t) => t.text)).toEqual([
      report,
    ]);
  });

  test('tool results, tool calls, thinking, subagents, compaction and deferred input stay hidden', async () => {
    put('human', 'user', 'Visible human');
    put('tool-result', 'user', [
      { type: 'tool_result', content: 'HIDDEN_TOOL_RESULT', tool_use_id: 'tool' },
    ]);
    put('thought', 'assistant', [
      { type: 'thinking', thinking: 'HIDDEN_THOUGHT' },
      { type: 'tool_use', name: 'Bash', input: { command: 'HIDDEN_COMMAND' } },
    ]);
    put('child', 'assistant', [{ type: 'text', text: 'HIDDEN_CHILD' }], { parent: 'tool' });
    put('compact', 'assistant', [{ type: 'text', text: 'HIDDEN_COMPACTION' }], { compact: true });
    put('deferred', 'user', 'HIDDEN_DEFERRED', { status: 'deferred' });
    put('reply', 'assistant', [{ type: 'text', text: 'Visible answer' }], { split: true });
    const before = digest();
    const value = await page({ before: 10, after: 10 });
    expect(value.turns.map((t) => t.text)).toEqual(['Visible human', 'Visible answer']);
    expect(JSON.stringify(value)).not.toContain('HIDDEN');
    expect(digest()).toBe(before);
  });

  test('stable scoped cursors page tied timestamps once despite a later append', async () => {
    for (let n = 0; n < 25; n++) put(`m-${n}`, 'user', `message ${n}`);
    let value = await page({ before: 1, after: 0 });
    const ids = value.turns.map((t) => t.messageId);
    expect(value.nextCursor).toBeDefined();
    put('new-append', 'user', 'Must not restart the cursor');
    while (value.nextCursor && ids.length < 50) {
      value = await page({ before: 1, after: 0, cursor: value.nextCursor });
      ids.push(...value.turns.map((t) => t.messageId));
    }
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    expect(ids).not.toContain('new-append');
    expect(value.nextCursor).toBeUndefined();
    expect(value.availability).toBe('complete');
  });

  test('continuation returns every byte of a long message without splitting Unicode', async () => {
    const large = 'x'.repeat(63_999) + '🔬' + 'Y'.repeat(100_000) + '\n';
    put('large', 'assistant', [{ type: 'text', text: large }], { split: true });
    const before = digest();
    const parts: string[] = [];
    let value = await page({ before: 0, after: 0 });
    for (let n = 0; n < 10; n++) {
      for (const turn of value.turns) {
        expect(Buffer.from(turn.text, 'utf8').toString('utf8')).toBe(turn.text);
        parts.push(turn.text);
      }
      if (!value.nextCursor) break;
      value = await page({ before: 0, after: 0, cursor: value.nextCursor });
    }
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(large);
    expect(digest()).toBe(before);
  });

  test('published file references survive alongside visible text without reading paths', async () => {
    const reference = {
      artifactId: 'a'.repeat(64),
      daemonId: '00000000-0000-4000-8000-000000000001',
      sessionId: 'worker',
      name: 'report.txt',
      byteLength: 8192,
      sha256: 'a'.repeat(64),
      path: '/synthetic-not-opened/handoffs/worker/published/report.txt',
    };
    put('files', 'assistant', [
      { type: 'text', text: 'Complete report attached' },
      { type: 'text', text: JSON.stringify({ handoffFiles: [reference] }) },
    ]);
    expect((await page({})).turns[0].files).toEqual([reference]);
  });

  test('an anchor on hidden material cannot substitute the next visible reply', async () => {
    put('child', 'assistant', [{ type: 'text', text: 'HIDDEN' }], { parent: 'tool' });
    put('next', 'assistant', [{ type: 'text', text: 'An unrelated visible reply' }]);
    expect(await page({ around: 'child', before: 0, after: 0 })).toMatchObject({
      turns: [],
      availability: 'reply_unavailable',
    });
  });

  test('a smaller continuation page cannot skip the rest of its original window', async () => {
    const first = 'A'.repeat(20_000);
    put('large-window', 'assistant', [{ type: 'text', text: first }]);
    put('following', 'user', 'Following message');
    let value = await page({ around: 'large-window', before: 0, after: 1 });
    const turns = [...value.turns];
    for (let n = 0; value.nextCursor && n < 10; n++) {
      value = await page({ cursor: value.nextCursor, before: 0, after: 0 });
      turns.push(...value.turns);
    }
    expect(
      turns
        .filter((t) => t.messageId === 'large-window')
        .map((t) => t.text)
        .join('')
    ).toBe(first);
    expect(turns.filter((t) => t.messageId === 'following').map((t) => t.text)).toEqual([
      'Following message',
    ]);
  });

  test('an unlocated reply says unavailable and a cursor cannot cross session scope', async () => {
    expect(await page({})).toMatchObject({ turns: [], availability: 'reply_unavailable' });
    expect(await page({ around: 'unknown' })).toMatchObject({
      turns: [],
      availability: 'reply_unavailable',
    });
    for (let n = 0; n < 5; n++) put(`m-${n}`, 'user', `message ${n}`);
    const value = await page({ before: 0, after: 0 });
    expect(value.nextCursor).toBeDefined();
    expect(await invoke({ sessionId: 'other', cursor: value.nextCursor })).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
  });
});
