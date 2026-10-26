import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { seedNeoSnapshotFixture } from '../../../packages/daemon/tests/helpers/neo-snapshot-fixture.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
let sequence = 0;
const pending = new Map<string, (reply: { data: unknown; error?: unknown }) => void>();
socket.onmessage = event => {
  const reply = JSON.parse(String(event.data));
  pending.get(reply.requestId)?.(reply);
};
async function invoke(name: string, input = {}) {
  const id = String(++sequence);
  const reply = new Promise<{ data: unknown; error?: unknown }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Timed out: ${name}`)), 15000);
    pending.set(id, value => { clearTimeout(timer); pending.delete(id); done(value); });
  });
  socket.send(JSON.stringify({ type: 'REQ', id, sessionId: 'global', version: '1.0.0', timestamp: new Date().toISOString(), method: 'operation.invoke', data: { name, input } }));
  const value = await reply;
  assert(!value.error, JSON.stringify(value.error));
  return value.data as import('../../../packages/shared/src/types/neo-snapshot.ts').NeoSnapshot;
}
try {
  assert.notEqual(app.server.port, 8399);
  seedNeoSnapshotFixture(app.db.getDatabase());
  await new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = fail; });
  const snapshot = await invoke('neo.snapshot');
  const rows = snapshot.todoAsks;
  const todo = rows.flatMap(entry => entry.todos).find(item => item.id === 'todo-230')!;
  const observed = { mode, asks: rows.length, todos: rows.flatMap(entry => entry.todos).length, questions: rows.flatMap(entry => entry.questions).length, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), cardBytes: Buffer.byteLength(JSON.stringify(rows)) };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  assert.equal(rows.length, mode === 'reproduce' ? 50 : 60);
  assert.equal(todo.instruction, mode === 'reproduce' ? 'x'.repeat(1155) : null);
  if (mode !== 'reproduce') {
    assert.equal(todo.report, null);
    const detail = await invoke('neo.ask.read', { todoId: todo.id }) as unknown as { ok: boolean; entry: { todos: typeof rows[number]['todos'] } };
    assert(detail.ok);
    assert.equal(detail.entry.todos.find(item => item.id === todo.id)?.instruction, 'x'.repeat(1155));
    app.db.getDatabase().prepare(`INSERT INTO neo_questions
      (id,ask_id,text,kind,state,options,multiple,created_at)
      VALUES ('summary-open','ask-18','Full synthetic question','choice','open','["Ship","Wait"]',0,1)`).run();
    const waiting = (await invoke('neo.snapshot')).todoAsks.find(entry => entry.ask.id === 'ask-18')!;
    assert.equal(waiting.state, 'waiting');
    assert.equal(waiting.summary?.openQuestionCount, 1);
    assert.equal(waiting.questions.length, 0);
    const opened = await invoke('neo.ask.read', { askId: 'ask-18' }) as unknown as { entry: typeof rows[number] };
    assert.equal(opened.entry.questions.find(question => question.id === 'summary-open')?.text, 'Full synthetic question');
    assert.deepEqual(opened.entry.questions.find(question => question.id === 'summary-open')?.options, ['Ship', 'Wait']);
  }
  console.log(JSON.stringify(observed));
} finally {
  socket.close();
  await app.cleanup();
}
