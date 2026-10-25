import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

test('todo worker reads preserve lists, recovery and PR windows; live writes commit before reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-todo-gateway-'));
  const path = join(dir, 'synthetic.db');
  const db = new Database(path);
  const gateway = new DbGateway(path, db);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db, () => {});
    createTables(db);
    bindGateway(db, gateway);
    const todos = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const prs = new CodingTodoPrRepository(db);
    todos.openAsk({
      id: 'a',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Synthetic ask',
      request: '',
      createdAt: 1,
    });
    const ref = { adapter: 'hyperneo' as const, id: 'synthetic' };
    for (let i = 0; i < 3; i++) {
      const id = `t${i}`;
      todos.addTodo(
        id,
        'a',
        { title: id, doneWhen: 'Observed', instruction: null, named: null, check: null },
        1
      );
      db.prepare("UPDATE neo_todos SET state = 'doing', started_at = ? WHERE id = ?").run(i, id);
      sessions.bind(id, ref, i);
    }
    db.exec("UPDATE neo_todo_sessions SET ref = NULL WHERE todo_id = 't2'");
    const expected = {
      recovery: sessions.unrecordedStarts(),
      awaiting: sessions.awaitingReports(),
      window: prs.window('t0'),
    };
    expect(await sessions.read('unrecordedStarts')).toEqual(expected.recovery);
    expect(await sessions.read('awaitingReports')).toEqual(expected.awaiting);
    expect(await prs.readWindow('t0')).toEqual(expected.window);
    expect(
      await sessions.write(
        'recordLive',
        't0',
        'running',
        '/session/synthetic',
        'https://example.com/synthetic'
      )
    ).toBe(true);
    expect(sessions.readLiveStatus('t0')).toBe('running');
    expect(
      await sessions.write(
        'recordLive',
        't0',
        'running',
        '/session/synthetic',
        'https://example.com/synthetic'
      )
    ).toBe(false);
    expect(await sessions.write('recordLive', 't0', 'done', undefined)).toBe(true);
    expect(sessions.readLinks('t0')).toMatchObject({
      link: '/session/synthetic',
      remoteLink: null,
    });
    sessions.recordNeedsYouSince('t0', 900);
    expect(
      await sessions.write(
        'recordProgress',
        't0',
        { landed: 7, live: { status: 'running', lastActivityAt: 7 }, cardStatus: 'running' },
        8
      )
    ).toBe(true);
    expect(sessions.readStartedAt('t0')).toBe(7);
    expect(sessions.readNeedsYouSince('t0')).toBeNull();
    expect(sessions.readCardCheck('t0')).toEqual({ checkedAt: 8, unchecked: false });
    expect(
      await sessions.write(
        'recordProgress',
        't0',
        { landed: null, live: null, cardStatus: null },
        9
      )
    ).toBe(false);
    expect(sessions.readLiveStatus('t0')).toBe('running');
    expect(sessions.readCardCheck('t0')).toEqual({ checkedAt: 9, unchecked: true });
    const claims = await Promise.all([
      sessions.write('claimNeedsYou', 't0', 10),
      sessions.write('claimNeedsYou', 't0', 11),
    ]);
    expect(claims.filter(Boolean)).toEqual([todos.getTodo('t0')]);
    expect(sessions.readNeedsYouSince('t0')).toBe(10);
    for (const [state, blockedBy, eligible] of [
      ['blocked', 'worker', true],
      ['blocked', 'question', false],
      ['blocked', 'human', false],
      ['done', null, false],
      ['failed', null, false],
      ['removed', null, false],
    ] as const) {
      db.prepare('UPDATE neo_todos SET state=?, blocked_by=? WHERE id=?').run(
        state,
        blockedBy,
        't0'
      );
      sessions.recordNeedsYouSince('t0', null);
      expect(Boolean(await sessions.write('claimNeedsYou', 't0', 12))).toBe(eligible);
      expect(sessions.readNeedsYouSince('t0')).toBe(eligible ? 12 : null);
    }
    expect(await sessions.write('claimNeedsYou', 'missing', 13)).toBeNull();
    db.prepare("UPDATE neo_todos SET state='doing' WHERE id='t0'").run();
    db.exec(
      "CREATE TRIGGER reject_incident BEFORE UPDATE OF needs_you_since ON neo_todo_sessions BEGIN SELECT RAISE(ABORT, 'synthetic incident refusal'); END"
    );
    await expect(sessions.write('claimNeedsYou', 't0', 14)).rejects.toThrow(
      'synthetic incident refusal'
    );
    expect(sessions.readNeedsYouSince('t0')).toBeNull();
    db.exec('DROP TRIGGER reject_incident');
    expect(await sessions.write('claimNeedsYou', 't0', 15)).toEqual(todos.getTodo('t0'));
  } finally {
    await gateway.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
