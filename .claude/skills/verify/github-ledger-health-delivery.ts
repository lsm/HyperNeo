process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { GitHubEventExtension } from '../../../packages/daemon/src/lib/external-events/github/github-event-extension.ts';
import { reportGitHubWatchHealth } from '../../../packages/daemon/src/lib/external-events/github/github-watch-inventory.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { codingWatchedRepos, initializeCodingWatches } from '../../../packages/daemon/src/lib/neo/packs/coding/watched-repos.ts';
import { createNeoService } from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(process.env[key], undefined);
for (const dir of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
process.env.PATH = join(run, 'bin') + ':' + process.env.PATH;
globalThis.fetch = (() => {
  throw new Error('External HTTP is disabled');
}) as typeof fetch;
const HOUR = 3_600_000;
const at = Date.now();
const realNow = Date.now;
let clock = at;
Date.now = () => clock;
const evidence: Record<string, unknown> = { checks: [] };
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let service: ReturnType<typeof createNeoService> | undefined;
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({
        port: 0,
        host: '127.0.0.1',
        dbPath: join(run, 'data/daemon.db'),
        workspaceRoot: join(run, 'workspace'),
      }),
      disableWorktrees: true,
      disableGoalProcessing: true,
    },
    verbose: false,
  });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
  const db = app.db.getDatabase();
  const root = 'neo:00000000-0000-4000-8000-00000000a772';
  db.prepare(
    'INSERT INTO sessions (id,title,type,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    root,
    'Synthetic Neo',
    'general',
    join(run, 'workspace'),
    new Date(at).toISOString(),
    new Date(at).toISOString(),
    'active',
    '{}',
    '{}'
  );
  db.prepare("INSERT INTO neo_session_bindings (session_id, kind) VALUES (?, 'neo')").run(root);
  const queue = (name: string) =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.message.message.content') AS text
             FROM job_queue WHERE queue = ?
              AND json_extract(payload, '$.to.sessionId') = ? ORDER BY created_at, rowid`
        )
        .all(name, root) as { text: string }[]
    ).map((row) => String(row.text));
  const told = (prefix: string) => ({
    digests: queue('neo_notes').filter((text) => text.startsWith(prefix)),
    wakes: queue('mailbox').filter((text) => text.startsWith(prefix)),
  });
  const ledger = new CodingPrLedgerRepository(db);
  const watched = new GitHubEventExtension(db).repo.upsertWatchedRepo({
    spaceId: 'sessions',
    owner: 'fixture',
    repo: 'stale',
    pollingEnabled: true,
  });
  const stalled = 'GitHub coverage stalled for polling:fixture/stale.';
  const poll = async (name: string, hours: number, reached: boolean) => {
    clock = at + hours * HOUR;
    await reportGitHubWatchHealth(
      ledger,
      [watched],
      new Set(reached ? [watched.id] : []),
      (event) => service!.attend(event),
      clock
    );
    const seen = told(stalled);
    (evidence.checks as unknown[]).push({ name, hours, ...seen });
    return seen;
  };
  for (const minutes of [0, 5]) await poll('a missed polling cycle', minutes / 60, false);
  assert.equal(told(stalled).digests.length, 0, 'two misses are not an incident');
  await poll('the third missed cycle', 10 / 60, false);
  await poll('another missed cycle', 15 / 60, false);
  await poll('an hour later', 1, false);
  assert.equal(told(stalled).digests.length, 1, 'the incident is one digest');
  await poll('a day after the incident began', 24 + 10 / 60, false);
  assert.equal(told(stalled).digests.length, 2, 'one more digest a day later');
  await poll('polling recovers', 25, true);
  const recovered = await poll('two days later, still recovered', 50, true);
  assert.equal(recovered.digests.length, 2, 'a recovered repository is not told again');
  assert.deepEqual(recovered.wakes, [], 'GitHub health never wakes Neo');

  const repo = 'synthetic/health';
  await app.db.updateGlobalSettings({ neo: { packs: ['coding'] } });
  db.prepare(
    "DELETE FROM neo_pack_preferences WHERE pack = 'coding' AND key = 'watchedRepos'"
  ).run();
  initializeCodingWatches(db, [repo]);
  assert.deepEqual(codingWatchedRepos(db), [repo]);
  clock = at + 60 * HOUR;
  ledger.replace(
    repo,
    [
      {
        repo,
        number: 1,
        title: 'Ready after CI',
        branch: 'topic',
        head: 'approved-head',
        state: 'approved_pending',
        closedAt: null,
      },
    ],
    clock
  );
  const pending = `GitHub readiness observation stalled for ${repo}#1`;
  for (const minutes of [5, 20, 25]) {
    clock = at + 60 * HOUR + minutes * 60_000;
    await service.sweepPacks();
    (evidence.checks as unknown[]).push({
      name: `real pack sweep, ${minutes} minutes after the last read`,
      ...told(pending),
      health: ledger.readHealth(repo),
    });
  }
  assert.equal(told(pending).digests.length, 1, 'a stalled readiness read is one digest');
  const rows = db.prepare('SELECT health_json FROM pack_coding_repo_health').all() as {
    health_json: string;
  }[];
  assert(
    rows.every((row) => JSON.parse(row.health_json).notices === undefined),
    'no told record is kept in the health row'
  );
  evidence.passed = true;
  console.log('PASS');
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await service?.dispose();
  await app?.cleanup();
  Date.now = realNow;
  writeFileSync(join(run, 'evidence/health-delivery.json'), JSON.stringify(evidence, null, 2));
}
