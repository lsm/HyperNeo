import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const sender = 'neo:10000000-0000-4000-8000-000000000004';
const check = { pack: 'core', kind: 'evidence', params: {} };
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP is disabled'); }) as typeof fetch;
try {
  const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  try {
    await app.jobProcessor.stop();
    const db = app.db.getDatabase();
    db.prepare("INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, 'Synthetic removal proof', '/tmp', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z', 'active', '{}', '{}')").run(sender);
    new NeoRepository(db).reserveBinding({ sessionId: sender, kind: 'neo', projectId: null });
    const registry = () => app.sessionManager.getOperationRegistry();
    const handler = createOperationMcpHandler(registry, () => ({ sessionId: sender, role: 'neo' }));
    const invoke = async (step: string, name: string, input: unknown) => {
      const reply = await handler({ name, input });
      const result = JSON.parse(reply.content[0].text);
      evidence.push({ step, name, input, result });
      console.log(`${step}: ${result.ok ? 'ok' : `refused ${result.reason ?? JSON.stringify(result).slice(0, 200)}`}`);
      return result;
    };
    const rows = (askId: string) =>
      Object.fromEntries(
        (db.prepare('SELECT title, state, depends_on AS dependsOn FROM neo_todos WHERE ask_id = ? ORDER BY position').all(askId) as { title: string; state: string; dependsOn: string }[])
          .map((row) => [row.title, `${row.state} ${row.dependsOn}`])
      );
    const cards = (askId: string) =>
      (db.prepare('SELECT id, state, kind, options, todos, cause, text FROM neo_questions WHERE ask_id = ? AND cause IS NOT NULL').all(askId) as { id: string; state: string; kind: string; options: string; todos: string; cause: string; text: string }[]);
    const chain = async (name: string) => {
      const ask = await invoke(`${name}: open the ask`, 'neo.ask.open', { title: `Synthetic ${name}`, request: `Synthetic request for ${name}` });
      assert.equal(ask.ok, true, JSON.stringify(ask));
      const add = async (title: string, after: string[]) => {
        const added = await invoke(`${name}: add ${title}`, 'neo.todo.add', { askId: ask.ask.id, title, check, after });
        assert.equal(added.ok, true, JSON.stringify(added));
        return added.todo.id as string;
      };
      const a = await add('A', []);
      const b = await add('B', [a]);
      const c = await add('C', [a]);
      const d = await add('D', [b]);
      return { askId: ask.ask.id as string, a, b, c, d };
    };
    const human = async (step: string, questionId: string, answer: string[]) => {
      const outcome = await invokeOperation(registry(), 'neo.question.answer', { questionId, answer }, { source: 'rpc', principal: 'local' });
      evidence.push({ step, questionId, answer, outcome });
      console.log(`${step}: ${outcome.kind}`);
      assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
    };

    const plain = await chain('no after');
    const missing = await invoke('no after: add without after', 'neo.todo.add', { askId: plain.askId, title: 'E', check });
    assert.notEqual(missing.ok, true, JSON.stringify(missing));
    assert.deepEqual(Object.keys(rows(plain.askId)), ['A', 'B', 'C', 'D']);
    const free = await invoke('no after: add with an empty after', 'neo.todo.add', { askId: plain.askId, title: 'E', check, after: [] });
    assert.equal(free.ok, true, JSON.stringify(free));
    assert.equal(rows(plain.askId).E, 'todo []');

    const kept = await chain('continue');
    const cont = await invoke('continue: remove A', 'neo.todo.remove', { todoId: kept.a, reason: 'Synthetic: not needed', dependents: 'continue' });
    assert.equal(cont.ok, true, JSON.stringify(cont));
    assert.deepEqual(rows(kept.askId), { A: 'removed []', B: 'todo []', C: 'todo []', D: `todo ["${kept.b}"]` });
    assert.deepEqual(cards(kept.askId), []);

    const gone = await chain('remove');
    const rem = await invoke('remove: remove A', 'neo.todo.remove', { todoId: gone.a, reason: 'Synthetic: not needed', dependents: 'remove' });
    assert.equal(rem.ok, true, JSON.stringify(rem));
    assert.deepEqual(rows(gone.askId), { A: 'removed []', B: `removed ["${gone.a}"]`, C: `removed ["${gone.a}"]`, D: `removed ["${gone.b}"]` });
    assert.deepEqual(cards(gone.askId), []);

    for (const [name, answer, after] of [
      ['card continue', 'Continue', (ids: { b: string }) => ({ A: 'removed []', B: 'todo []', C: 'todo []', D: `todo ["${ids.b}"]` })],
      ['card remove', 'Remove these', (ids: { a: string; b: string }) => ({ A: 'removed []', B: `removed ["${ids.a}"]`, C: `removed ["${ids.a}"]`, D: `removed ["${ids.b}"]` })],
    ] as const) {
      const ids = await chain(name);
      const removed = await invoke(`${name}: remove A with no decision`, 'neo.todo.remove', { todoId: ids.a, reason: 'Synthetic: not needed' });
      assert.equal(removed.ok, true, JSON.stringify(removed));
      assert.deepEqual(rows(ids.askId), { A: 'removed []', B: `todo ["${ids.a}"]`, C: `todo ["${ids.a}"]`, D: `todo ["${ids.b}"]` });
      const [card, ...extra] = cards(ids.askId);
      evidence.push({ step: `${name}: the card`, card });
      assert.deepEqual(extra, []);
      assert.deepEqual(
        { ...card, id: null, options: JSON.parse(card.options), todos: JSON.parse(card.todos) },
        { id: null, state: 'open', kind: 'choice', options: ['Continue', 'Remove these'], todos: [ids.b, ids.c], cause: 'removed_prerequisite', text: '"A" was removed. Continue "B", "C" without it, or remove these steps too?' }
      );
      await human(`${name}: the human answers ${answer}`, card.id, [answer]);
      assert.deepEqual(rows(ids.askId), after(ids));
      assert.equal(cards(ids.askId)[0].state, 'answered');
    }
  } finally { await app.cleanup(); }
  console.log('PASS: on the real daemon a removed prerequisite ends in continued dependents, removed dependents, or one card whose answer the daemon applies; an add without after is refused.');
} finally { globalThis.fetch = network; writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2)); }
