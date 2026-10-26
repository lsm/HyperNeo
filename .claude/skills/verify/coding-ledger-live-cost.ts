import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const baseline = resolve('packages/daemon/src/lib/neo/packs/coding/.verify-baseline-source.ts');
const repo = 'lsm/HyperNeo';
if (process.argv[2] !== 'child') {
  const evidence = resolve(process.argv[2]);
  mkdirSync(evidence);
  const requests: { mode: string; graphql: boolean; cost: number; remaining: number | null }[] = [];
  let mode = 'baseline';
  const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const args = await request.json() as string[];
    assert(args[0] === 'api' && args.includes('--include'));
    assert(args[1] === 'graphql' || args[1].startsWith(`repos/${repo}/pulls?`));
    if (args[1] === 'graphql') {
      assert(args.includes('o=lsm') && args.includes('n=HyperNeo'));
      assert(!args.some(arg => arg.includes('mutation')));
    }
    const child = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    let budget: { cost: number; remaining: number } | undefined;
    if (args[1] === 'graphql') {
      const start = stdout.indexOf('{');
      budget = JSON.parse(stdout.slice(start)).data?.rateLimit;
    }
    requests.push({ mode, graphql: args[1] === 'graphql', cost: budget?.cost ?? 0, remaining: budget?.remaining ?? null });
    return Response.json({ stdout, stderr, exit });
  } });
  try {
    writeFileSync(baseline, execFileSync('git', ['show', `${process.argv[3]}:packages/daemon/src/lib/neo/packs/coding/pr-ledger-source.ts`]));
    for (mode of ['baseline', 'fixed']) {
      const run = mkdtempSync(join(process.env.TMPDIR!, 'ledger-cost-'));
      try {
        for (const dir of ['home', 'tmp', 'bin']) mkdirSync(join(run, dir));
        writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
        writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}\nconst r=await fetch('http://127.0.0.1:${bridge.port}',{method:'POST',body:JSON.stringify(process.argv.slice(2))});const v=await r.json();await Bun.write(Bun.stdout,v.stdout);await Bun.write(Bun.stderr,v.stderr);process.exit(v.exit);\n`, { mode: 0o700 });
        const child = Bun.spawn([process.execPath, self, 'child', mode, run], { env: {
          HOME: join(run, 'home'), TMPDIR: join(run, 'tmp'), PATH: `${join(run, 'bin')}:${process.env.PATH}`,
          NODE_ENV: 'test', HYPERNEO_DATA_DIR: join(run, 'data'), LOG_LEVEL: 'warn',
        }, stdout: 'pipe', stderr: 'pipe' });
        const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        writeFileSync(join(evidence, `${mode}.log`), out + err);
        assert.equal(exit, 0, out + err);
      } finally { rmSync(run, { recursive: true, force: true }); }
    }
    const sum = (kind: string) => requests.filter(r => r.mode === kind).reduce((n, r) => n + r.cost, 0);
    const result = { baselinePointsPerSweep: sum('baseline'), baselineEstimatedPointsPerHour: sum('baseline') * 12,
      fixedPointsForTwelveSimulatedSweeps: sum('fixed'), requests,
      note: 'Actual GitHub-reported costs; twelve five-minute sweep timestamps simulated without waiting an hour. Reads public PR metadata only.' };
    writeFileSync(join(evidence, 'cost.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    writeFileSync(join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
    bridge.stop(true); rmSync(baseline, { force: true });
  }
} else {
  const [mode, run] = process.argv.slice(3);
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(run, 'home'));
  const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
  const { getConfig } = await import('../../../packages/daemon/src/config.ts');
  const { CodingPrLedgerRepository, reconcileCodingPrLedger, planCodingLedgerRead } = await import('../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts');
  const { readCodingLedgerRepo } = await import(mode === 'baseline' ? baseline : '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger-source.ts');
  const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  const clock = Date.now, start = clock();
  try {
    await app.jobProcessor.stop(); assert.notEqual(app.server.port, 8399);
    app.db.updateGlobalSettings({ neo: { packs: [] } });
    const db = app.db.getDatabase(), ledger = new CodingPrLedgerRepository(db);
    db.prepare("UPDATE neo_pack_preferences SET value_json=? WHERE pack='coding' AND key='watchedRepos'").run(JSON.stringify([repo]));
    for (let tick = 0; tick < (mode === 'baseline' ? 1 : 12); tick++) {
      Date.now = () => start + tick * 300_000;
      await reconcileCodingPrLedger(ledger, [repo], async name => {
        const raw = await readCodingLedgerRepo(name);
        assert(planCodingLedgerRead(raw, Date.now()), JSON.stringify(raw));
        return raw;
      }, Date.now());
      assert.equal(ledger.health.read(repo.toLowerCase())?.misses ?? ledger.health.read(repo)?.misses, 0);
      assert(ledger.list().length > 0, 'Isolated ledger must contain public PRs');
    }
    console.log(JSON.stringify({ mode, rows: ledger.list().length, isolated: true }));
  } finally { Date.now = clock; await app.cleanup(); }
}
