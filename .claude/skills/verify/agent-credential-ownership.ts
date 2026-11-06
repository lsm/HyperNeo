import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { writeRuntimeDescriptor } from '../../../packages/daemon/src/lib/runtime-descriptor.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const peerMode = process.argv[2] === '--peer';
if (!peerMode) await import('./ask-markdown-http.ts');
const app = await createDaemonApp({
  config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, peerMode ? 'data/peer.db' : 'data/daemon.db') }), disableWorktrees: true },
  standalone: true, verbose: false,
});
let peer: ReturnType<typeof Bun.spawn> | undefined;
let releaseDescriptor = () => {};
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(app.server.port, 8399);
  const origin = `http://127.0.0.1:${app.server.port}`;
  if (peerMode) {
    const stop = new Promise<void>((done) => process.once('SIGTERM', () => done()));
    writeFileSync(join(run, 'peer-ready.json'), JSON.stringify({ origin }));
    await stop;
  } else {
    const cli = async () => {
      const child = Bun.spawn([process.execPath, 'packages/cli/main.ts', 'read', `${origin}/ask/synthetic.md`], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { exit, card: stdout.startsWith('# Plan the visit\n'), error: stderr };
    };
    assert.equal((await cli()).exit, 0);
    const credential = readLocalCredential(join(run, 'data/agent-read.credential'), origin);
    releaseDescriptor = writeRuntimeDescriptor('127.0.0.1', app.server.port);
    peer = Bun.spawn([process.execPath, import.meta.filename, '--peer', run], {
      stdout: Bun.file(join(run, 'evidence/peer.log')), stderr: Bun.file(join(run, 'evidence/peer.log')),
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(run, 'peer-ready.json')) && peer.exitCode === null && Date.now() < deadline) await Bun.sleep(50);
    assert(existsSync(join(run, 'peer-ready.json')), 'Second daemon must start');
    const second = JSON.parse(readFileSync(join(run, 'peer-ready.json'), 'utf8'));
    const primary = await cli();
    const foreign = await fetch(`${second.origin}/ask/synthetic.md`, { headers: { authorization: `Bearer ${credential}` } });
    const observed = { primary, secondaryAgentStatus: foreign.status, separateDaemons: true, sharedDataDirectory: true, separateDatabases: true };
    writeFileSync(join(run, 'evidence/ownership.json'), JSON.stringify(observed, null, 2));
    assert.equal(primary.exit, 0, primary.error);
    assert.equal(primary.card, true);
    assert.equal(foreign.status, 401, 'A second daemon must not enroll the first daemon credential');
    assert.equal(new DevicePairingRepository(app.db.getDatabase()).listDevices().filter((device) => device.kind === 'agent').length, 1);
  }
} finally {
  let peerExit = 0;
  if (peer) {
    peer.kill('SIGTERM');
    const timer = setTimeout(() => peer?.kill('SIGKILL'), 15_000);
    peerExit = await peer.exited;
    clearTimeout(timer);
  }
  releaseDescriptor();
  await app.cleanup();
  writeFileSync(join(run, `evidence/${peerMode ? 'peer' : 'owner'}-cleanup.json`), JSON.stringify({ daemonStopped: true }));
  assert.equal(peerExit, 0, 'Second daemon must stop cleanly');
}
