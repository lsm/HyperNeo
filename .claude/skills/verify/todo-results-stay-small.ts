import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { LOCAL_RPC_PRINCIPAL } from '../../../packages/daemon/src/lib/operations/caller.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
const sender = 'neo:10000000-0000-4000-8000-000000000003';
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const instruction = (n: number) => `Instruction ${n}: ${'synthetic step detail '.repeat(80)}`;
const report = (n: number) => `Report ${n}: ${'synthetic finding '.repeat(40)}`;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
try {
  await app.jobProcessor.stop();
  const db = app.db.getDatabase(), store = new NeoAskTodoRepository(db);
  const registry = app.sessionManager.getOperationRegistry();
  const handler = createOperationMcpHandler(() => registry, () => ({ sessionId: sender, role: 'neo' }));
  const agent = async (name: string, input: unknown) => {
    const reply = await handler({ name, input });
    assert.equal(reply.isError ?? false, false, reply.content[0].text);
    const result = JSON.parse(reply.content[0].text);
    assert.equal(result.ok, true, reply.content[0].text);
    return result;
  };
  db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic todo size proof', '/tmp', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z', 'active', '{}', '{}')").run(sender);
  new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
  const opened = await agent('neo.ask.open', {
    title: 'Synthetic eleven-step ask',
    request: 'Measure todo result sizes',
    todos: Array.from({ length: 11 }, (_, n) => ({ after: [], title: `Step ${n}`, check: { pack: 'core', kind: 'evidence', params: { path: join(run, `missing-${n}`) } } })),
  });
  const ids: string[] = opened.todos.map((todo: { id: string }) => todo.id);
  ids.forEach((id, n) => store.updateTodo(store.getTodo(id)!, { instruction: instruction(n), report: report(n) }, Date.now()));
  const fullList = bytes(store.listTodos(opened.ask.id));
  const held = await agent('neo.todo.hold', { todoId: ids[0], reason: 'Synthetic wait' });
  const edited = await agent('neo.todo.edit', { todoId: ids[1], title: 'Step 1 renamed' });
  const others = (result: unknown, own: number) => ids.filter((_, n) => n !== own && JSON.stringify(result).includes(`Instruction ${n}:`));
  assert.equal(held.todo.id, ids[0]); assert.equal(held.todo.state, 'blocked'); assert(!('todos' in held));
  assert.deepEqual(others(held, 0), []);
  assert.equal(edited.todo.title, 'Step 1 renamed'); assert(!('todos' in edited));
  assert.deepEqual(others(edited, 1), []);
  const entry = await agent('neo.ask.read', { askId: opened.ask.id });
  assert.equal(entry.entry.todos.length, 11);
  assert(entry.entry.todos.every((todo: object) => Object.keys(todo).sort().join() === 'id,state,title'));
  assert(!JSON.stringify(entry).includes('Instruction '));
  const detail = await agent('neo.todo.read', { todoId: ids[3] });
  assert.equal(detail.todo.instruction, instruction(3)); assert.equal(detail.todo.report, report(3));
  assert.deepEqual(others(detail, 3), []);
  const human = await invokeOperation(registry, 'neo.ask.read', { askId: opened.ask.id }, { source: 'rpc', principal: LOCAL_RPC_PRINCIPAL });
  assert.equal(human.kind, 'completed');
  const card = (human as { value: { entry: { todos: { instruction: string | null }[] } } }).value;
  assert.equal(card.entry.todos.filter((todo) => todo.instruction?.startsWith('Instruction ')).length, 11);
  const sizes = { fullTodoList: fullList, hold: bytes(held), edit: bytes(edited), agentAskRead: bytes(entry), todoRead: bytes(detail), humanAskRead: bytes(card) };
  writeFileSync(join(run, 'evidence/sizes.json'), `${JSON.stringify(sizes, null, 2)}\n`);
  writeFileSync(join(run, 'evidence/agent-ask-read.json'), `${JSON.stringify(entry, null, 2)}\n`);
  console.log(JSON.stringify(sizes));
} finally {
  await app.cleanup();
}
