import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });

if (process.argv[2] === '--phase') {
  const root = process.argv[3];
  const phase = process.argv[4];
  const { createDaemonApp } = await import(pathToFileURL(join(root, 'packages/daemon/src/app.ts')).href);
  const { getConfig } = await import(pathToFileURL(join(root, 'packages/daemon/src/config.ts')).href);
  let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
  try {
    app = await createDaemonApp({
      config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true },
      verbose: false,
    });
    assert.notEqual(app.server.port, 8399);
    await app.jobProcessor.stop();
    await app.spaceRuntimeService.ready();
    const db = app.db.getDatabase();
    if (phase === 'seed') {
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='neo_card_search_fts'").get(), null);
      db.exec(`INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at)
        VALUES ('index-ask-a','synthetic-owner','Synthetic ship','Request atlas',1,1),
               ('index-ask-b','synthetic-owner','Synthetic second','Request birch',2,2);
        INSERT INTO neo_todos(id,ask_id,position,title,done_when,report,created_at,updated_at)
        VALUES ('index-todo','index-ask-a',0,'Synthetic upload','Synthetic check','Report cedar',1,3);
        INSERT INTO neo_questions(id,ask_id,text,kind,state,answer,answered_by,answered_at,created_at)
        VALUES ('index-question','index-ask-a','Synthetic question','reply','answered','"Original"','button',42,1)`);
      writeFileSync(join(run, 'evidence/seed.json'), JSON.stringify({ phase, indexAbsent: true, port: app.server.port }));
    } else {
      const count = db.prepare('SELECT COUNT(*) AS count FROM neo_card_search_content').get() as { count: number };
      assert.equal(count.count, 4);
      const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'neo_card_search_*' ORDER BY name").all();
      assert.equal(triggers.length, 12);
      const question = () => db.prepare("SELECT body,updated_at FROM neo_card_search_content WHERE source='question'").get();
      const matches = (term: string) => db.prepare(`SELECT c.source,c.entity_id,c.ask_id FROM neo_card_search_fts f
        JOIN neo_card_search_content c ON c.id=f.rowid WHERE neo_card_search_fts MATCH ? ORDER BY c.id`).all(term);
      if (phase === 'upgrade') {
        assert.deepEqual(question(), { body: 'Original', updated_at: 42 });
        assert.equal(matches('atlas').length, 1);
        assert.equal(matches('cedar').length, 1);
        db.exec(`UPDATE neo_questions SET answer='"Catalog"',answered_at=99 WHERE id='index-question';
          UPDATE neo_todos SET ask_id='index-ask-b' WHERE id='index-todo'`);
      }
      assert.deepEqual(question(), { body: 'Catalog', updated_at: 99 });
      assert.deepEqual(matches('cedar'), [{ source: 'todo', entity_id: 'index-todo', ask_id: 'index-ask-b' }]);
      assert.equal(matches('Original').length, 0);
      assert.equal(matches('Catalog').length, 1);
      db.exec("INSERT INTO neo_card_search_fts(neo_card_search_fts,rank) VALUES('integrity-check',1)");
      const snapshot = {
        schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name GLOB 'neo_card_search_*' ORDER BY name").all(),
        rows: db.prepare('SELECT * FROM neo_card_search_content ORDER BY id').all(),
      };
      const saved = join(run, 'evidence/upgraded.json');
      if (phase === 'restart') assert.deepEqual(snapshot, JSON.parse(readFileSync(saved, 'utf8')));
      writeFileSync(join(run, `evidence/${phase === 'upgrade' ? 'upgraded' : 'restarted'}.json`), JSON.stringify(snapshot, null, 2));
      console.log(JSON.stringify({ phase, rows: count.count, triggers: triggers.length, questionTimestamp: 99, movedTodoIndexed: true, ftsIntegrity: true, restartUnchanged: phase === 'restart' }));
    }
  } finally {
    await app?.cleanup();
  }
} else {
  const root = resolve(import.meta.dir, '../../..');
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(git('status', '--porcelain'), '', 'Commit the owned checkout before switching proof versions');
  const branch = git('symbolic-ref', '--short', 'HEAD');
  const before = git('rev-parse', 'HEAD');
  const baseline = git('rev-parse', 'origin/dev');
  assert(!existsSync(join(run, 'data/daemon.db')));
  mkdirSync(join(run, 'workspace'));
  const helper = join(run, 'card-search-upgrade.ts');
  copyFileSync(import.meta.path, helper);
  let child: ReturnType<typeof spawn> | undefined;
  const interrupted = () => child?.kill('SIGTERM');
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  try {
    for (const phase of ['seed', 'upgrade', 'restart']) {
      git('switch', '--detach', phase === 'seed' ? baseline : before);
      child = spawn(process.execPath, [helper, '--phase', root, phase, run], { stdio: 'inherit' });
      await new Promise<void>((done, fail) => {
        child!.once('error', fail);
        child!.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`${phase}: exit ${code}, signal ${signal}`)));
      });
      child = undefined;
    }
    writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ pass: true, baseline, upgraded: before, startupCount: 3, restartUnchanged: true, actualDaemon: true, providerRegistered: false }, null, 2));
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child!.once('exit', () => done()));
      child.kill('SIGKILL');
      await exited;
    }
    git('switch', branch);
    assert.equal(git('rev-parse', 'HEAD'), before);
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}
