import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket, readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

await import('./ask-markdown-http.ts');
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const evidence = join(run, 'evidence');
const config = { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true };
if (process.platform === 'darwin') assert.equal(Bun.spawnSync(['bash', '.claude/skills/verify/resource-check.sh']).exitCode, 0);
let app = await createDaemonApp({ config, standalone: true, verbose: false });
let socket: WebSocket | undefined;
let stopped = false;
async function rpc<T>(name: string, input: unknown): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((done, fail) => {
    assert(socket);
    const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 10_000);
    socket.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.requestId !== id) return;
      clearTimeout(timer);
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, 'packages/cli/main.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  const base = `http://127.0.0.1:${app.server.port}`;
  assert.notEqual(app.server.port, 8399);
  const link = `${base}/ask/synthetic.md`;
  const path = join(run, 'data/agent-read.credential');
  const agent = readLocalCredential(path);
  const human = readLocalCredential();
  assert.notEqual(agent, human);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0);
  const headers = { authorization: `Bearer ${agent}` };
  assert.equal((await fetch(link, { headers })).status, 200);
  const read = await cli('read', link);
  assert.equal(read.code, 0, read.stderr);
  assert(read.stdout.startsWith('# Plan the visit\n'));
  assert(!read.stdout.includes(agent));
  const missing = await fetch(link);
  assert.equal(missing.status, 401);
  assert((await missing.text()).includes('hyperneo read'));
  const refused = await new Promise<number>((done, fail) => {
    const ws = createLocalSocket(`${base.replace('http:', 'ws:')}/ws`, path);
    ws.onopen = () => { ws.close(); fail(new Error('Agent must never upgrade to WebSocket')); };
    ws.onerror = () => done(401);
    setTimeout(() => { ws.close(); fail(new Error('Agent WebSocket refusal timed out')); }, 5_000).unref();
  });
  assert.equal(refused, 401);
  socket = createLocalSocket(`${base.replace('http:', 'ws:')}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('Human WebSocket failed')); });
  assert.equal((await rpc<{ok:boolean}>('neo.ask.read', { askId: 'synthetic' })).ok, true);
  const madeReply = await cli('pair', '--kind', 'agent', '--name', 'Synthetic remote agent');
  assert.equal(madeReply.code, 0, madeReply.stderr);
  const made = JSON.parse(madeReply.stdout);
  assert.equal(made.approval, 'pending');
  const redeem = () => fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: made.code, name: 'Synthetic remote agent' }) });
  assert.equal((await redeem()).status, 403);
  assert.equal((await rpc<{ok:boolean}>('device.pair.approve', { codeId: made.codeId })).ok, true);
  const paired = await redeem();
  assert.equal(paired.status, 200);
  const remote = await paired.json();
  assert.equal(remote.kind, 'agent');
  const remoteHeaders = { authorization: `Bearer ${remote.credential}` };
  assert.equal((await fetch(link, { headers: remoteHeaders })).status, 200);
  assert.equal((await fetch(`${base}/ws`, { headers: remoteHeaders })).status, 401);
  assert.equal((await rpc<{ok:boolean}>('device.revoke', { deviceId: remote.deviceId })).ok, true);
  assert.equal((await fetch(link, { headers: remoteHeaders })).status, 401);
  const local = new DevicePairingRepository(app.db.getDatabase()).listDevices().find((device) => device.kind === 'agent' && device.name === 'Local agent reader')!;
  assert.equal((await rpc<{ok:boolean}>('device.revoke', { deviceId: local.id })).ok, true);
  assert.equal((await fetch(link, { headers })).status, 401);
  assert.equal((await cli('read', link)).code, 1);
  socket.close(); socket = undefined;
  await app.cleanup(); stopped = true;
  if (process.platform === 'darwin') assert.equal(Bun.spawnSync(['bash', '.claude/skills/verify/resource-check.sh']).exitCode, 0);
  app = await createDaemonApp({ config, standalone: true, verbose: false }); stopped = false;
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  assert.equal(readFileSync(path, 'utf8'), agent);
  const restarted = `http://127.0.0.1:${app.server.port}`;
  assert.equal((await fetch(`${restarted}/ask/synthetic.md`, { headers })).status, 401);
  assert.equal((await fetch(`${restarted}/ws`, { headers: { authorization: `Bearer ${human}` } })).status, 204);
  writeFileSync(join(evidence, 'agent-read.json'), JSON.stringify({ passed: true, ownerOnly: true, separateCredential: true, cliRead: 200, anonymous: 401, agentWebSocket: 401, remoteApprovalRequired: true, remoteRead: 200, revokedLocalAndRemote: 401, revocationSurvivesRestart: true, humanStillWorks: true }, null, 2));
} finally {
  socket?.close();
  if (!stopped) await app.cleanup();
  writeFileSync(join(evidence, 'agent-cleanup.json'), JSON.stringify({ daemonStopped: true }));
}
