import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { neoTrackerReads } from '../../../packages/daemon/src/storage/repositories/neo-tracker-mirror.ts';
import type { NeoTrackerAdapter } from '../../../packages/daemon/src/lib/neo/pack-contract.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const adapter: NeoTrackerAdapter = {
  id: 'fixture', enabled: () => true, home: () => 'example/repo',
  create: async (item) => {
    const ref = gh('create', item.marker);
    if (process.argv.includes('--seed')) {
      writeFileSync(join(run, 'seed-ready.json'), JSON.stringify({ ref }));
      await new Promise(() => {});
    }
    return { ref };
  },
  find: async (marker) => gh('find', marker) || null,
  link: async (parent, child) => { gh('link', parent, child); return true; },
  close: async (ref, outcome) => { gh('close', ref, outcome); return true; },
};
if (process.argv.includes('--seed') || process.argv.includes('--recover')) {
  const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  await app.db.updateGlobalSettings({ neo: { packs: [] } });
  const neo = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  neo.packs = () => [{ id: 'fixture', describe: 'Synthetic tracker', tracker: adapter }];
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  const add = (id: string) => store.addTodo(id, 'ask', { title: id, instruction: null, named: null, check: null, doneWhen: 'Done' }, 2);
  try {
    if (process.argv.includes('--seed')) {
      store.openAsk({ id: 'ask', projectId: null, sessionId: 'synthetic', originMessageId: null, title: 'Synthetic plan', request: 'Private details', createdAt: 1 });
      await Promise.all([neo.sweepPacks(), neo.sweepPacks()]);
    } else {
      const facts = await app.db.gateway.call(neoTrackerReads, 'facts');
      assert.equal(facts.mirrors[0].state, 'creating');
      await neo.sweepPacks();
      const recovered = await app.db.gateway.call(neoTrackerReads, 'facts');
      assert.equal(recovered.mirrors[0].state, 'bound');
      assert.equal(readFileSync(join(run, 'bin/gh.items'), 'utf8').trim().split('\n').length, 1);
      add('late');
      await Promise.all([neo.sweepPacks(), neo.sweepPacks()]);
      await neo.sweepPacks();
      await neo.sweepPacks();
      assert.equal(readFileSync(join(run, 'bin/gh.effects'), 'utf8').trim().split('\n').length, 1);
      app.db.getDatabase().prepare("UPDATE neo_todos SET state = 'done'").run();
      await neo.sweepPacks();
      app.db.getDatabase().prepare("UPDATE neo_todos SET state = 'doing'").run();
      await neo.sweepPacks();
      add('active'); add('failed');
      await neo.sweepPacks();
      app.db.getDatabase().prepare("UPDATE neo_todos SET state = 'failed' WHERE id = 'failed'").run();
      await neo.sweepPacks();
      app.db.getDatabase().prepare("UPDATE neo_asks SET status = 'done'").run();
      await neo.sweepPacks();
      const waiting = await app.db.gateway.call(neoTrackerReads, 'facts');
      assert.equal(waiting.mirrors.find((row) => row.ownerKind === 'ask')?.state, 'bound');
      await neo.sweepPacks();
      store.openAsk({ id: 'dropped', projectId: null, sessionId: 'synthetic', originMessageId: null, title: 'Cancelled plan', request: 'Private details', createdAt: 3 });
      await neo.sweepPacks();
      app.db.getDatabase().prepare("UPDATE neo_asks SET status = 'dropped' WHERE id = 'dropped'").run();
      await neo.sweepPacks();
      const effects = readFileSync(join(run, 'bin/gh.effects'), 'utf8').trim().split('\n');
      assert.deepEqual(effects.filter((line) => line.startsWith('close ')), [
        'close example/repo#2 completed', 'close example/repo#3 not_planned',
        'close example/repo#4 not_planned', 'close example/repo#1 completed', 'close example/repo#5 not_planned',
      ]);
      assert.equal((await app.db.gateway.call(neoTrackerReads, 'facts')).mirrors.length, 0);
      store.openAsk({ id: 'capped', projectId: null, sessionId: 'synthetic', originMessageId: null, title: 'Fail-open plan', request: 'Private details', createdAt: 4 });
      store.addTodo('cap-child', 'capped', { title: 'Failing child', instruction: null, named: null, check: null, doneWhen: 'Done' }, 5);
      await neo.sweepPacks();
      const closeCalls: string[] = [];
      adapter.close = async (ref) => { closeCalls.push(ref); return ref === 'example/repo#7' ? { reason: 'Unavailable' } : true; };
      app.db.getDatabase().prepare("UPDATE neo_asks SET status = 'done' WHERE id = 'capped'").run();
      for (let sweep = 0; sweep < 6; sweep++) await neo.sweepPacks();
      assert.deepEqual(closeCalls, ['example/repo#7', 'example/repo#7', 'example/repo#7', 'example/repo#6']);
      const capped = await app.db.gateway.call(neoTrackerReads, 'facts');
      assert.equal(capped.mirrors.find((row) => row.ownerId === 'cap-child')?.failures, 3);
      assert.equal(capped.mirrors.find((row) => row.ownerId === 'capped')?.state, 'closed');
      writeFileSync(join(run, 'evidence/retry-cap.json'), JSON.stringify({ closeCalls, failures: 3, parentClosed: true }));
      writeFileSync(join(run, 'evidence/recovery.json'), JSON.stringify({ recovered: recovered.mirrors[0], port: app.server.port, serviceSweep: true, lifecycleEffects: effects }));
    }
  } finally { await neo.dispose(); await app.cleanup(); }
} else {
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'bin/gh'), `#!/bin/sh
case "$1" in
  create) printf '%s\\n' "$2" >> "$0.items"; count=$(wc -l < "$0.items" | tr -d ' '); printf 'example/repo#%s\\n' "$count" ;;
  find) if [ -f "$0.items" ]; then awk -v marker="$2" '$0 == marker { print "example/repo#" NR; exit }' "$0.items"; fi ;;
  link|close) printf '%s %s %s\\n' "$1" "$2" "$3" >> "$0.effects" ;;
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
  const capLogs = readFileSync(join(run, 'evidence/recovery.log'), 'utf8').match(/Tracker retry limit reached/g) ?? [];
  assert.equal(capLogs.length, 1);
  const items = readFileSync(join(run, 'bin/gh.items'), 'utf8').trim().split('\n');
  const createCount = items.filter((marker) => marker === 'hyperneo:ask:ask').length;
  assert.equal(items.length, 7);
  assert.equal(createCount, 1);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ createCount, recoveryExit: exit, seedKilledBeforeBound: true, concurrentSweeps: true, capLogCount: capLogs.length, seed: JSON.parse(readFileSync(join(run, 'seed-ready.json'), 'utf8')) }));
  console.log(`PASS: service sweep recovery and lifecycle; createCount=${createCount}; recoveryExit=${exit}; totalCreateCount=${items.length}`);
}
