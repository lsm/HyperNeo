import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';

test('the snapshot and ask reads return each ask its derived topic and key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-ask-topic-'));
  const path = join(dir, 'synthetic.db');
  const db = new Database(path);
  const gateway = new DbGateway(path, db);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db, () => {});
    createTables(db);
    bindGateway(db, gateway);
    const projects = new NeoRepository(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    for (const [id, session] of [
      ['p', 's1'],
      ['q', 's2'],
    ]) {
      projects.saveProject({ id, title: 'Shop', summary: '', context: '' }, 0);
      db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run(
        `work:${hostname()}\u0000claude-code\u0000${session}`,
        id
      );
    }
    const open = (id: string, topic: string | null, session?: string) => {
      store.openAsk({
        id,
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: id,
        topic,
        request: '',
        createdAt: 1,
      });
      if (!session) return;
      store.addTodo(
        `${id}-t`,
        id,
        { title: 'Step', doneWhen: 'Observed', check: null, instruction: null, named: null },
        1
      );
      sessions.create(`${id}-t`, { verb: 'send', ref: { adapter: 'claude-code', id: session } });
    };
    open('in-p', 'X', 's1');
    open('in-q', 'Y', 's2');
    open('lower', 'kids', undefined);
    open('upper', 'Kids', undefined);
    const topics = Object.fromEntries(
      (await store.read('snapshot', undefined, 10)).asks.map((ask) => [
        ask.id,
        [ask.topic, ask.topicKey],
      ])
    );
    expect(topics).toEqual({
      'in-p': ['Shop', 'p'],
      'in-q': ['Shop', 'q'],
      lower: ['kids', 'pick:kids'],
      upper: ['Kids', 'pick:kids'],
    });
    const read = await store.read('askFacts', { askId: 'in-q' });
    expect([read.ask?.topic, read.ask?.topicKey]).toEqual(['Shop', 'q']);
  } finally {
    await gateway.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude senders inherit their project topic through either session alias', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-ask-sender-topic-'));
  const path = join(dir, 'synthetic.db');
  const db = new Database(path);
  const gateway = new DbGateway(path, db);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db, () => {});
    createTables(db);
    bindGateway(db, gateway);
    const projects = new NeoRepository(db);
    const store = new NeoAskTodoRepository(db);
    for (const [id, adapter, session] of [
      ['desktop', 'claude-desktop', 'local_s1'],
      ['cli', 'claude-code', 's2'],
    ]) {
      projects.saveProject({ id, title: id, summary: '', context: '' }, 0);
      db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run(
        `work:${hostname()}\u0000${adapter}\u0000${session}`,
        id
      );
      store.openAsk({
        id,
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: id,
        topic: null,
        request: '',
        createdAt: 1,
      });
      store.addTodo(
        `${id}-t`,
        id,
        {
          title: 'Step',
          doneWhen: 'Observed',
          check: null,
          instruction: null,
          named: { requestFrom: `claude-code:${id === 'desktop' ? 's1' : 's2'}` },
        },
        1
      );
    }
    const topics = Object.fromEntries(
      (await store.read('snapshot', undefined, 10)).asks.map((ask) => [
        ask.id,
        [ask.topic, ask.topicKey],
      ])
    );
    expect(topics).toEqual({ desktop: ['desktop', 'desktop'], cli: ['cli', 'cli'] });
  } finally {
    await gateway.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the plan read counts Neo's picks on asks opened in the last 30 days, open or settled", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-topic-list-'));
  const path = join(dir, 'synthetic.db');
  const db = new Database(path);
  const gateway = new DbGateway(path, db);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    runMigrations(db, () => {});
    createTables(db);
    bindGateway(db, gateway);
    const store = new NeoAskTodoRepository(db);
    const day = 24 * 60 * 60 * 1000;
    for (const [id, topic, age] of [
      ['open', 'kids', 0],
      ['settled', 'Kids', 2],
      ['other', '邮件', 29],
      ['old', '邮件', 31],
      ['none', null, 0],
    ] as const)
      store.openAsk({
        id,
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: id,
        topic,
        request: '',
        createdAt: Date.now() - age * day,
      });
    db.prepare("UPDATE neo_asks SET status = 'done' WHERE id = 'settled'").run();
    const { topics } = await store.read('planContext');
    expect([...topics].sort((a, b) => a.topic.localeCompare(b.topic))).toEqual([
      { topic: 'kids', count: 1 },
      { topic: 'Kids', count: 1 },
      { topic: '邮件', count: 1 },
    ]);
  } finally {
    await gateway.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
