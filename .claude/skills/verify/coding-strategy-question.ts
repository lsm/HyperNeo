process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'workspace'), { recursive: true });
const config = { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true };
const evidence: Record<string, unknown> = {};
const first = await createDaemonApp({ config, verbose: false });
try {
  await first.jobProcessor.stop();
  const db = first.db.getDatabase();
  db.exec(`INSERT INTO neo_concerns (id,title,summary,context,revision,created_at,updated_at)
    VALUES ('synthetic-project','Synthetic','','',1,1,1);
    INSERT INTO neo_project_workspaces (alias,project_id)
    VALUES ('repository:github.com/synthetic/sessions','synthetic-project');
    INSERT INTO neo_pack_preferences (pack,scope_kind,scope_key,key,value_json,set_by,set_at)
    VALUES ('coding','repo','github.com/synthetic/sessions','sessionStrategy','"per_pr"','human',1);
    INSERT INTO neo_pack_preferences (pack,scope_kind,scope_key,key,value_json,set_by,set_at)
    VALUES ('coding','global','','sessionStrategy','"per_task"','human',1);
    DELETE FROM migration_markers WHERE key='migration_525'`);
} finally { await first.cleanup(); }

const app = await createDaemonApp({ config, verbose: false });
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const rpc = (name: string, input: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timeout')), 10000);
    ws!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.requestId !== id && reply.id !== id) return;
      clearTimeout(timer);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const core = await rpc('pack.preferences.get', { pack: 'core', scope: { kind: 'project', key: 'synthetic-project' }, key: 'sessionReuse' });
  const globalCore = await rpc('pack.preferences.get', { pack: 'core', scope: { kind: 'global', key: '' }, key: 'sessionReuse' });
  assert.equal(core.preference?.value, 'per_todo');
  assert.equal(globalCore.preference, null);
  const db = app.db.getDatabase();
  const coding = db.prepare("SELECT scope_kind AS scope, value_json AS value FROM neo_pack_preferences WHERE pack='coding' AND key='sessionStrategy' ORDER BY scope_kind").all();
  assert.deepEqual(coding, [{ scope: 'global', value: '\"per_task\"' }, { scope: 'repo', value: '\"per_pr\"' }]);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({ id: 'synthetic-ask', projectId: 'synthetic-project', sessionId: 'synthetic-neo', originMessageId: null, title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
  const todo = store.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Work', instruction: 'Synthetic', named: null, check: { pack: 'coding', kind: 'pr_merged', params: {} }, doneWhen: 'Done' }, 2, 'github.com/synthetic/sessions');
  const target = { verb: 'start' as const, adapter: 'hyperneo', name: 'backend' };
  sessions.create(todo.id, target);
  const neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const pack = neo.packs().find((candidate) => candidate.id === 'coding')!;
  let asked = 0;
  const decision = await pack.workerTarget!(todo, target, async () => ({ kind: 'failed', code: 'synthetic', message: 'No worker' }), async () => { asked++; return { kind: 'failed', code: 'synthetic', message: 'Unexpected question' }; });
  assert.deepEqual(decision, { value: target });
  assert.equal(asked, 0);
  evidence.core = core.preference;
  evidence.coding = coding;
  evidence.globalCore = globalCore.preference;

  evidence.decision = decision;
  evidence.codingQuestions = asked;
  console.log('PASS: the restarted daemon copies the host-prefixed coding value to its project, preserves the old value and does not ask the coding question.');
} finally {
  writeFileSync(join(run, 'evidence/strategy-question.json'), JSON.stringify(evidence, null, 2));
  ws?.close();
  await app.cleanup();
}
