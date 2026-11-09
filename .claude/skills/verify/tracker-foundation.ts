import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { neoTrackerReads, neoTrackerWrites } from '../../../packages/daemon/src/storage/repositories/neo-tracker-mirror.ts';
import { planNeoTrackerMirror, planNeoTrackerRecovery } from '../../../packages/daemon/src/lib/neo/tracker-mirror-plan.ts';
import type { NeoTrackerAdapter } from '../../../packages/daemon/src/lib/neo/pack-contract.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const adapter: NeoTrackerAdapter = {
  id: 'fixture', enabled: (owner) => owner.kind === 'todo', home: () => 'example/repo',
  create: async (item) => ({ ref: execFileSync('gh', ['create', item.marker], { encoding: 'utf8' }).trim() }),
  find: async (marker) => execFileSync('gh', ['find', marker], { encoding: 'utf8' }).trim() || null,
  link: async () => true, close: async () => true,
};
if (process.argv.includes('--seed') || process.argv.includes('--recover')) {
  const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const gateway = app.db.gateway;
  if (process.argv.includes('--seed')) {
    const todos = new NeoAskTodoRepository(app.db.getDatabase());
    todos.openAsk({ id: 'ask', projectId: null, sessionId: 'synthetic', originMessageId: null, title: 'Synthetic plan', request: 'Mirror', createdAt: 1 });
    todos.addTodo('todo', 'ask', { title: 'Synthetic step', instruction: 'Private details', named: null, check: null, doneWhen: 'Done' }, 2);
    const facts = await gateway.call(neoTrackerReads, 'facts');
    const op = planNeoTrackerMirror(facts.asks, facts.todos, facts.mirrors, [adapter])[0];
    await gateway.call(neoTrackerWrites, 'put', { ...op.row, updatedAt: Date.now() });
    const created = await adapter.create(op.item);
    assert('ref' in created);
    app.db.getDatabase().prepare("UPDATE neo_asks SET status = 'done'").run();
    writeFileSync(join(run, 'seed-ready.json'), JSON.stringify({ port: app.server.port, created }));
    await new Promise(() => {});
  } else {
    try {
      const facts = await gateway.call(neoTrackerReads, 'facts');
      assert.equal(facts.mirrors[0].state, 'creating');
      const op = planNeoTrackerMirror(facts.asks, facts.todos, facts.mirrors, [adapter])[0];
      const found = await adapter.find(op.item.marker, op.row.home);
      const recovered = planNeoTrackerRecovery(op.row, found);
      assert(recovered);
      await gateway.call(neoTrackerWrites, 'put', { ...op.row, ref: recovered.ref, state: 'bound', updatedAt: Date.now() });
      const bound = await gateway.call(neoTrackerReads, 'facts');
      assert.equal(bound.mirrors[0].ref, 'example/repo#1');
      assert.equal(bound.mirrors[0].state, 'bound');
      assert.equal(planNeoTrackerMirror(bound.asks, bound.todos, bound.mirrors, [adapter]).length, 0);
      assert.equal(op.item.body, 'Synthetic step\n\n<!-- hyperneo:todo:todo -->');
      app.db.getDatabase().prepare("UPDATE neo_asks SET status = 'open'").run();
      adapter.enabled = () => true;
      const parentFacts = await gateway.call(neoTrackerReads, 'facts');
      const parent = planNeoTrackerMirror(parentFacts.asks, parentFacts.todos, parentFacts.mirrors, [adapter])[0];
      assert.equal(parent.item.body, 'Synthetic plan\n\n<!-- hyperneo:ask:ask -->');
      await gateway.call(neoTrackerWrites, 'put', { ...parent.row, ref: 'example/repo#2', state: 'bound' });
      const linkFacts = await gateway.call(neoTrackerReads, 'facts');
      const link = planNeoTrackerMirror(linkFacts.asks, linkFacts.todos, linkFacts.mirrors, [adapter])[0];
      assert.equal(link.action, 'link');
      assert.equal(await adapter.link(link.parent!, link.row.ref!), true);
      await gateway.call(neoTrackerWrites, 'put', { ...link.row, parentRef: link.parent! });
      const linked = await gateway.call(neoTrackerReads, 'facts');
      assert.equal(planNeoTrackerMirror(linked.asks, linked.todos, linked.mirrors, [adapter]).length, 0);
      app.db.getDatabase().prepare("UPDATE neo_asks SET status = 'done'").run();
      await gateway.call(neoTrackerWrites, 'put', { ...parent.row, ref: 'example/repo#2', state: 'closed' });
      const open = await gateway.call(neoTrackerReads, 'facts');
      assert.deepEqual(open.mirrors.map((row) => row.ownerId), ['todo']);
      writeFileSync(join(run, 'evidence/review-fixes.json'), JSON.stringify({ titleOnlyBodies: true, repeatedLinks: 0, closedRowsReturned: 0 }));
      writeFileSync(join(run, 'evidence/recovery.json'), JSON.stringify({ recovered: bound.mirrors[0], port: app.server.port, constructionOnly: true }));
    } finally { await app.cleanup(); }
  }
} else {
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'bin/gh'), `#!/bin/sh
case "$1" in
  create) printf '%s\\n' "$2" >> "$0.items"; printf 'example/repo#1\\n' ;;
  find) if [ -f "$0.items" ] && grep -Fqx "$2" "$0.items"; then printf 'example/repo#1\\n'; fi ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  const child = Bun.spawn([process.execPath, import.meta.path, '--seed', run], { stdout: 'pipe', stderr: 'pipe' });
  const seedOut = new Response(child.stdout).text();
  const seedErr = new Response(child.stderr).text();
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(run, 'seed-ready.json')) && Date.now() < deadline) await Bun.sleep(100);
    assert(existsSync(join(run, 'seed-ready.json')), 'Seed must reach external create before the kill');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    writeFileSync(join(run, 'evidence/seed.log'), await seedOut + await seedErr);
  }
  const recovery = Bun.spawn([process.execPath, import.meta.path, '--recover', run], { stdout: 'pipe', stderr: 'pipe' });
  const recoveryOut = new Response(recovery.stdout).text();
  const recoveryErr = new Response(recovery.stderr).text();
  const exit = await recovery.exited;
  writeFileSync(join(run, 'evidence/recovery.log'), await recoveryOut + await recoveryErr);
  assert.equal(exit, 0, 'Recovery daemon must exit successfully');
  const createCount = readFileSync(join(run, 'bin/gh.items'), 'utf8').trim().split('\n').length;
  assert.equal(createCount, 1);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ createCount, recoveryExit: exit, seedKilledBeforeBound: true, seed: JSON.parse(readFileSync(join(run, 'seed-ready.json'), 'utf8')) }));
  console.log(`PASS: construction-only gateway recovery; createCount=${createCount}; recoveryExit=${exit}`);
}
