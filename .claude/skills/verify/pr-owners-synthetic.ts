import { execFileSync } from 'node:child_process';
import { readCodeIdentity } from '../../../packages/daemon/src/lib/drivers/code-identity.ts';
import { planCodingPrOwner } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { claudeOwnerSession } from './pr-owner-session.ts';
import { strict as assert } from 'node:assert';
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingClaudeOwnerReader } from '../../../packages/daemon/src/lib/neo/packs/coding/claude-pr-owners.ts';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';

export async function verifySyntheticPrOwners(runText: string) {
  const run = resolve(runText);
  assert(process.env.NODE_ENV === 'test');
  assert(process.env.HOME === join(run, 'home'));
  assert(process.env.HYPERNEO_DATA_DIR === join(run, 'data'));
  const path = join(run, 'data/owners.db');
  assert(!existsSync(path));
  const scope = join(run, 'sessions/account/scope');
  const folder = join(run, 'workspace');
  const project = join(run, 'projects', folder.replace(/[/.]/g, '-'));
  for (const dir of [scope, project, join(run, 'home'), join(run, 'data')])
    mkdirSync(dir, { recursive: true });
  const git = (args: string[]) =>
    execFileSync('git', args, {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  git(['init', '-q', folder]);
  git(['-C', folder, 'remote', 'add', 'origin', 'git@github.com:synthetic/cart-sandbox.git']);
  git([
    '-C',
    folder,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'Synthetic root',
  ]);
  const url = (number: number) => `https://github.com/synthetic/cart-sandbox/pull/${number}`;
  const operation = (action: string, number: number) =>
    JSON.stringify({
      type: 'user',
      toolUseResult: { gitOperation: { pr: { action, number, url: url(number) } } },
    }) + '\n';
  const padding = (
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Synthetic ordinary step. '.repeat(160) }] },
    }) + '\n'
  ).repeat(520);
  let transcriptBytes = 0;
  for (let i = 0; i < 64; i++) {
    const data =
      padding +
      (i === 0
        ? operation('commented', 4)
        : i === 1
          ? operation('created', 6)
          : i === 4
            ? operation('created', 8)
            : '');
    writeFileSync(join(project, `cli-${i}.jsonl`), data);
    transcriptBytes += Buffer.byteLength(data);
    writeFileSync(
      join(scope, `local_${i}.json`),
      JSON.stringify({
        sessionId: `local_${i}`,
        cliSessionId: `cli-${i}`,
        cwd: folder,
        lastActivityAt: 1000 - i,
        ...(i === 3 ? { branch: 'b7' } : {}),
        ...(i === 4
          ? {}
          : {
              prs:
                i === 0
                  ? [{ url: url(4) }]
                  : i === 1
                    ? [{ url: url(6) }]
                    : i === 2
                      ? [{ url: url(5), own: true }]
                      : [],
            }),
      })
    );
  }
  const db = new Database(path);
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  const now = Date.now();
  const watcher = {
    ref: { adapter: 'claude-desktop', id: 'local_4' },
    status: 'done' as const,
    lastActivityAt: 996,
    remotes: ['git@github.com:synthetic/cart-sandbox.git'],
    branches: [],
    openedPrs: [url(9)],
  };
  ledger.observeSessions([watcher], now);

  let identityReads = 0;
  const readClaudeOwners = createCodingClaudeOwnerReader(
    join(run, 'sessions'),
    join(run, 'projects'),
    async (folder) => {
      identityReads++;
      return readCodeIdentity(folder);
    }
  );
  const pack = createCodingPack({
    database: () => db,
    readPrs: async () => [],
    todoPrs: new CodingTodoPrRepository(db),
    prLedger: ledger,
    prEvents: new CodingPrEventRepository(db),
    prSweep: new CodingPrSweepRepository(db),
    prSweepDeps: {
      tell: async () => {
        throw new Error('unexpected delivery');
      },
      wake: async () => {
        throw new Error('unexpected wake');
      },
    },
    projectRepos: () => ['synthetic/cart-sandbox'],
    readClaudeOwners,
    readLedgerRepo: async () => ({
      data: {
        rateLimit: { remaining: 4000 },
        repository: {
          nameWithOwner: 'synthetic/cart-sandbox',
          open: {
            pageInfo: { hasNextPage: false },
            nodes: [4, 5, 6, 7, 8, 9].map((number) => ({
              number,
              title: `Synthetic ${number}`,
              headRefName: `b${number}`,
              headRefOid: `h${number}`,
              state: 'OPEN',
              isDraft: false,
              mergeable: 'MERGEABLE',
              reviewDecision: null,
              closedAt: null,
            })),
          },
          done: { nodes: [] },
        },
      },
    }),
  });
  const phases: {
    name: string;
    elapsedMs: number;
    maxLagMs: number;
    owners: Record<string, unknown>[];
  }[] = [];
  let last = performance.now();
  let maxLag = 0;
  const timer = setInterval(() => {
    const at = performance.now();
    maxLag = Math.max(maxLag, at - last - 10);
    last = at;
  }, 10);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
  const sweep = async (name: string) => {
    await pause();
    maxLag = 0;
    last = performance.now();
    const start = performance.now();
    await pack.sweep!(now);
    const elapsedMs = performance.now() - start;
    await pause();
    const owners = ledger.snapshot(null, now).map((row) => ({ pr: row.pr, ownerId: row.ownerId }));
    const replay = (await readClaudeOwners()).map((value) =>
      claudeOwnerSession(value, value.ref.id === watcher.ref.id ? watcher.openedPrs : [])
    );
    const ledgerRows = db
      .prepare('SELECT repo, number, branch, owner FROM pack_coding_pr_ledger')
      .all() as { repo: string; number: number; branch: string; owner: string | null }[];
    for (const row of ledgerRows)
      assert.equal(planCodingPrOwner({ ...row, owner: null }, new Map(), replay), row.owner);
    assert.equal(
      identityReads,
      1,
      'one local Git identity read per retained folder, not per sweep'
    );
    phases.push({ name, elapsedMs, maxLagMs: maxLag, owners });
    const report = {
      syntheticOnly: true,
      surface: 'real coding-pack sweep/reconcile and snapshot repositories',
      sessions: 64,
      transcriptBytes,
      gitRemoteLookup: 'real local Git repository, no network',
      identityReads,
      verificationReplayMatchesLedger: true,
      phases,
    };
    writeFileSync(join(run, 'observed.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(phases.at(-1)) + '\n');
    assert(maxLag < 1000, `reconcile lag ${maxLag}ms exceeds1s goal`);
    return owners;
  };
  try {
    const first = await sweep('cold');
    assert.deepEqual(first, [
      { pr: 'synthetic/cart-sandbox#4', ownerId: null },
      { pr: 'synthetic/cart-sandbox#5', ownerId: 'local_2' },
      { pr: 'synthetic/cart-sandbox#6', ownerId: 'local_1' },
      { pr: 'synthetic/cart-sandbox#7', ownerId: 'local_3' },
      { pr: 'synthetic/cart-sandbox#8', ownerId: 'local_4' },
      { pr: 'synthetic/cart-sandbox#9', ownerId: 'local_4' },
    ]);
    assert.deepEqual(await sweep('unchanged'), first);
    ledger.observeSessions([watcher], now + 1);
    assert.deepEqual(await sweep('watcher-repeat'), first);
    appendFileSync(join(project, 'cli-1.jsonl'), operation('created', 4));
    const appended = await sweep('appended');
    assert.equal(appended[0].ownerId, 'local_1');
    const meta = join(scope, 'local_1.json');
    writeFileSync(
      meta,
      JSON.stringify({
        sessionId: 'local_1',
        cliSessionId: 'cli-1',
        cwd: folder,
        lastActivityAt: 999,
        prs: [{ url: url(6), dismissed: true }],
      })
    );
    utimesSync(meta, new Date(), new Date(Date.now() + 5000));
    const dismissed = await sweep('dismissed');
    assert.equal(dismissed[2].ownerId, null);
    assert.equal(dismissed[0].ownerId, 'local_1');
  } finally {
    clearInterval(timer);
    db.close();
  }
}
