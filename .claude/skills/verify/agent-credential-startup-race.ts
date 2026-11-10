import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv.at(-1)!);
const mode = process.argv[2];
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const deadline = () => Date.now() + 30_000;
async function waitFor(path: string) {
  const until = deadline();
  while (!fs.existsSync(path) && Date.now() < until) await Bun.sleep(25);
  assert(fs.existsSync(path), `Missing proof signal ${path}`);
}
if (mode === '--first' || mode === '--second') {
  if (mode === '--first') {
    const { mock } = await import('bun:test');
    const rename = fs.renameSync;
    mock.module('node:fs', () => ({ ...fs, renameSync(from: string, to: string) {
      if (to === join(run, 'data/runtime.json')) {
        fs.writeFileSync(join(run, 'first-paused'), '');
        const until = deadline();
        while (!fs.existsSync(join(run, 'release-first')) && Date.now() < until)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        assert(fs.existsSync(join(run, 'release-first')), 'First writer must be released');
      }
      return rename(from, to);
    } }));
  }
  const { writeRuntimeDescriptor } = await import('../../../packages/daemon/src/lib/runtime-descriptor.ts');
  const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
  const { getConfig } = await import('../../../packages/daemon/src/config.ts');
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
  const port = listener.port;
  assert.notEqual(port, 8399);
  listener.stop(true);
  const release = writeRuntimeDescriptor('127.0.0.1', port);
  let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
  try {
    app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port,
      dbPath: join(run, mode === '--first' ? 'data/daemon.db' : 'data/contender.db') }), disableWorktrees: true }, standalone: true, verbose: false });
    await app.spaceRuntimeService?.ready();
    await app.jobProcessor.stop();
    const stop = new Promise<void>((done) => process.once('SIGTERM', () => done()));
    fs.writeFileSync(join(run, `${mode.slice(2)}-ready.json`), JSON.stringify({ origin: `http://127.0.0.1:${port}`, pid: process.pid }));
    await stop;
  } finally {
    await app?.cleanup();
    release();
    fs.writeFileSync(join(run, `evidence/${mode.slice(2)}-cleanup.json`), JSON.stringify({ daemonStopped: true }));
  }
} else {
  await import('./ask-markdown-http.ts');
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const spawn = (name: string) => {
    const child = Bun.spawn([process.execPath, import.meta.filename, `--${name}`, run], {
      stdout: Bun.file(join(run, `evidence/${name}.log`)), stderr: Bun.file(join(run, `evidence/${name}.log`)),
    });
    children.push(child);
  };
  try {
    spawn('first');
    await waitFor(join(run, 'first-paused'));
    spawn('second');
    await waitFor(join(run, 'second-ready.json'));
    const second = JSON.parse(fs.readFileSync(join(run, 'second-ready.json'), 'utf8'));
    const descriptorPath = join(run, 'data/runtime.json');
    const secondClaimed = fs.existsSync(descriptorPath) && JSON.parse(fs.readFileSync(descriptorPath, 'utf8')).pid === second.pid;
    fs.writeFileSync(join(run, 'release-first'), '');
    await waitFor(join(run, 'first-ready.json'));
    const first = JSON.parse(fs.readFileSync(join(run, 'first-ready.json'), 'utf8'));
    const cli = Bun.spawn([process.execPath, 'packages/cli/main.ts', 'read', `${first.origin}/ask/synthetic.md`], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
    const { readLocalCredential } = await import('../../../packages/daemon/src/lib/pairing/local-credential.ts');
    const token = readLocalCredential(join(run, 'data/agent-read.credential'), first.origin);
    const refused = await fetch(`${second.origin}/ask/synthetic.md`, { headers: { authorization: `Bearer ${token}` } });
    const observed = { secondClaimedDuringFirstPublish: secondClaimed, cliExit: exit, cardRead: stdout.startsWith('# Plan the visit\n'), cliError: stderr, otherDaemonStatus: refused.status };
    fs.writeFileSync(join(run, 'evidence/startup-race.json'), JSON.stringify(observed, null, 2));
    assert.equal(secondClaimed, false, 'A contender must not claim while the first writer is publishing');
    assert.equal(exit, 0, stderr);
    assert.equal(observed.cardRead, true);
    assert.equal(refused.status, 401);
  } finally {
    fs.writeFileSync(join(run, 'release-first'), '');
    const exits = await Promise.all(children.map(async (child) => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      try { return await child.exited; } finally { clearTimeout(timer); }
    }));
    fs.writeFileSync(join(run, 'evidence/race-cleanup.json'), JSON.stringify({ exits }));
    for (const exit of exits) assert.equal(exit, 0, 'Each owned daemon must stop cleanly');
  }
}
