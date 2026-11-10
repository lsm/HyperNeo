import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { initializeCodingWatches } from '../../../packages/daemon/src/lib/neo/packs/coding/watched-repos.ts';
import { WorkTurnRepository } from '../../../packages/daemon/src/storage/repositories/work-turn-repository.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });

const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: Record<string, unknown> = {};
try {
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const db = app.db.getDatabase();
  db.prepare("DELETE FROM neo_pack_preferences WHERE pack = 'coding' AND key = 'watchedRepos'").run();
  initializeCodingWatches(db, ['synthetic/proof']);
  const ledger = new CodingPrLedgerRepository(db);
  const events = new CodingPrEventRepository(db);
  const turns = new WorkTurnRepository(db);
  const at = Date.now();
  const worker = { adapter: 'claude-desktop', id: 'worker' };
  const insert = db.prepare(`INSERT INTO pack_coding_pr_ledger
    (repo, number, title, branch, head, state, state_since, read_at, created_at, author_is_bot)
    VALUES ('synthetic/proof', ?, ?, ?, 'head', 'open', ?, ?, ?, 0)`);
  for (const number of [1, 2, 3]) insert.run(number, `PR ${number}`, `b${number}`, at, at, at);
  const url = (number: number) => `https://github.com/synthetic/proof/pull/${number}`;
  const turn = (id: string, number: number, complete: boolean) => ({
    id, startedAt: at - 1000, endedAt: at + 1000, ended: 'end_turn', inputs: [],
    urls: [url(number)], finalUrls: [url(number)], complete, cursor: '{"seq":1,"consumed":0}',
  });
  await turns.record(worker, [turn('placed', 1, true), turn('unread', 2, false)]);
  ledger.assignOwners();
  const owner = (number: number) =>
    (db.prepare("SELECT owner FROM pack_coding_pr_ledger WHERE repo = 'synthetic/proof' AND number = ?").get(number) as { owner: string | null }).owner;
  evidence.owners = [owner(1), owner(2), owner(3)];
  assert.equal(owner(1), JSON.stringify(worker));
  assert.equal(owner(2), null);
  assert.equal(owner(3), null);
  db.prepare('UPDATE pack_coding_pr_unowned_state SET activated_at = 0').run();
  const notice = events.pendingUnowned(at, { key: null, recipient: 'synthetic-neo', status: 'absent' });
  evidence.notice = notice;
  assert(notice?.text.includes('synthetic/proof#3'), JSON.stringify(notice));
  assert(!notice.text.includes('synthetic/proof#1'), notice.text);
  assert(!notice.text.includes('synthetic/proof#2'), notice.text);
  console.log('PASS: on a real daemon DB the producing turn owns #1, an unread turn holds #2, and only #3 is announced as unowned.');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
