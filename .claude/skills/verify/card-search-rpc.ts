import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv.at(-1)!);
const inMemory = process.argv.includes('memory');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const name of ['home', 'workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { JobQueueProcessor } = await import('../../../packages/daemon/src/storage/job-queue-processor.ts');
const { Database: SQLite } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const start = JobQueueProcessor.prototype.start;
const prepare = SQLite.prototype.prepare;
const processors = new Set<InstanceType<typeof JobQueueProcessor>>();
let measuring = false;
let mainCardSqlAttempts = 0;
SQLite.prototype.prepare = function (...args) {
  const statement = Reflect.apply(prepare, this, args);
  if (!/\bneo_card_search(?:_content|_fts)?\b/i.test(args[0])) return statement;
  return new Proxy(statement, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...values: unknown[]) => {
        if (measuring && ['get', 'all', 'iterate', 'run', 'values'].includes(String(key))) {
          mainCardSqlAttempts++;
          if (!inMemory) throw new Error('card search SQL reached the main thread');
        }
        return Reflect.apply(value, target, values);
      };
    },
  });
};
const evidence: Record<string, unknown> = {};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: InstanceType<typeof WebSocketClientTransport> | undefined;
try {
  JobQueueProcessor.prototype.start = function () {
    processors.add(this);
    return start.call(this);
  };
  app = await createDaemonApp({
    config: {
      ...getConfig({ host: '127.0.0.1', port: 0, dbPath: inMemory ? ':memory:' : join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }),
      disableWorktrees: true,
      disableGoalProcessing: true,
    },
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  await Promise.all([...processors].map((processor) => processor.stop()));
  const db = app.db.getDatabase();
  db.exec(`INSERT INTO neo_asks (id, session_id, title, request, outcome, created_at, updated_at)
    VALUES ('ask-garden', 'neo:proof', 'Release the garden catalog', 'Upload the finished catalog to the shared drive', 'Published', 1, 1)`);
  db.exec(`INSERT INTO neo_asks (id, session_id, title, request, created_at, updated_at)
    VALUES ('ask-seeds', 'neo:proof', 'Order seedlings', 'Order the spring seedlings', 1, 1)`);
  db.exec(`INSERT INTO neo_todos (id, ask_id, position, title, state, report, evidence, next_action, created_at, updated_at, done_when)
    VALUES ('todo-pack', 'ask-garden', 0, 'Pack the catalog', 'doing', 'Upload finished with exit 0', 'logs/upload.txt', 'waiting on review', 1, 2, 'catalog packed')`);
  db.exec(`INSERT INTO neo_questions (id, ask_id, text, kind, answer, created_at)
    VALUES ('q-first', 'ask-seeds', 'Catalog or seedlings first?', 'choice', '"Catalog finale"', 1)`);
  db.exec(`INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at)
    VALUES ('ask-bracket','neo:proof','[draft] collection','Finish herbarium',1,1)`);
  db.exec(`INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at)
    VALUES ('old-chinese','neo:proof','历史记录','旧记录里的构建版本已完成',1,1)`);
  const hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
  });
  hub.registerTransport(transport);
  await transport.initialize();
  const search = (input: Record<string, unknown>) =>
    hub.request<{ ok: boolean; results: unknown[]; nextCursor: string | null }>('operation.invoke', {
      name: 'neo.ask.search',
      input,
    });
  measuring = true;
  const page = await search({ query: 'catalog' });
  evidence.firstPage = page;
  assert.equal(page.ok, true);
  assert.ok(page.results.length >= 3, JSON.stringify(page));
  const todo = page.results.find((hit) => hit.todoId === 'todo-pack');
  const question = page.results.find((hit) => hit.questionId === 'q-first');
  assert.ok(todo && todo.field === 'title', JSON.stringify(page.results));
  assert.ok(String(todo.snippet).toLowerCase().includes('catalog'));
  assert.ok(question && question.field === 'title');
  const report = await search({ query: 'upload' });
  evidence.reportPage = report;
  const body = report.results.find((hit) => hit.todoId === 'todo-pack');
  assert.equal(body.field, 'body');
  assert.ok(String(body.snippet).includes('Upload finished'));
  const answer = await search({ query: 'finale' });
  assert.equal(answer.results.length, 1);
  assert.equal(answer.results[0].questionId, 'q-first');
  assert.equal(answer.results[0].field, 'body');
  const paged = await search({ query: 'catalog', limit: 2 });
  assert.equal(paged.results.length, 2);
  assert.equal(typeof paged.nextCursor, 'string');
  const rest = await search({ query: 'catalog', limit: 2, cursor: paged.nextCursor! });
  assert.equal(rest.results.length, 1);
  assert.equal(rest.nextCursor, null);
  const bracket = await search({ query: 'herbarium' });
  evidence.bracketPage = bracket;
  assert.equal(bracket.results.length, 1);
  assert.equal(bracket.results[0].field, 'meta');
  const bracketTitle = await search({ query: 'draft' });
  evidence.bracketTitlePage = bracketTitle;
  assert.equal(bracketTitle.results.length, 1);
  assert.equal(bracketTitle.results[0].field, 'title');
  assert.equal(typeof bracketTitle.results[0].snippet, 'string');
  const chinese = await search({ query: '构建版' });
  assert.deepEqual(chinese.results.map((hit) => [hit.askId, hit.field]), [['old-chinese', 'meta']]);
  const short = await search({ query: '构建' });
  assert.deepEqual(short.results.map((hit) => [hit.askId, hit.field]), [['old-chinese', 'meta']]);
  evidence.oldChineseCard = { threeCharacters: chinese, twoCharacters: short, noPriorCardRead: true };
  await assert.rejects(search({ query: 'a bc' }), /query_too_short/);
  evidence.backend = inMemory ? 'memory' : 'file';
  if (inMemory) assert(mainCardSqlAttempts > 0);
  else assert.equal(mainCardSqlAttempts, 0);
  evidence.mainCardSqlAttempts = mainCardSqlAttempts;
} finally {
  measuring = false;
  JobQueueProcessor.prototype.start = start;
  await transport?.close();
  await Promise.all([...processors].map((processor) => processor.stop()));
  await app?.cleanup();
  SQLite.prototype.prepare = prepare;
  writeFileSync(
    join(run, 'evidence/card-search-rpc.json'),
    JSON.stringify(evidence, null, 2)
  );
  for (const name of ['data', 'home', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
  assert.equal(existsSync(join(run, 'evidence/card-search-rpc.json')), true);
}
console.log(`ok card search answers over the operations door (${inMemory ? 'explicit in-memory fallback' : 'no card SQL on main'}), with bracketed fields and an unloaded old Chinese card`);
