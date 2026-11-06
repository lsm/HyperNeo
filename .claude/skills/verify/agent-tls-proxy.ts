import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket, readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await import('./ask-markdown-http.ts');
const cert = join(run, 'proxy.crt');
const key = join(run, 'proxy.key');
const config = join(run, 'proxy.cnf');
writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=server\nprompt=no\n[dn]\nCN=127.0.0.1\n[server]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`);
const certificate = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config], { stdout: 'pipe', stderr: 'pipe' });
assert.equal(certificate.exitCode, 0, certificate.stderr.toString());
const app = await createDaemonApp({
  config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  standalone: true,
  verbose: false,
});
let proxy: ReturnType<typeof Bun.serve> | undefined;
let collector: ReturnType<typeof Bun.serve> | undefined;
let socket: WebSocket | undefined;
let collectorRequests = 0;
async function cli(dataDir: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, 'packages/cli/main.ts', ...args], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, HYPERNEO_DATA_DIR: dataDir, NODE_EXTRA_CA_CERTS: cert },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { exit, stdout, stderr };
}
async function rpc<T>(name: string, input: unknown): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((done, fail) => {
    assert(socket);
    const timer = setTimeout(() => fail(new Error(`${name} timed out`)), 10_000);
    socket.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.requestId !== id) return;
      clearTimeout(timer);
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply.data);
    };
    socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(app.server.port, 8399);
  const backend = `http://127.0.0.1:${app.server.port}`;
  proxy = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set('x-forwarded-proto', 'https');
      headers.set('x-forwarded-host', url.host);
      headers.set('host', new URL(backend).host);
      return fetch(`${backend}${url.pathname}`, {
        method: request.method, headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
        redirect: 'manual',
      });
    },
  });
  assert.notEqual(proxy.port, 8399);
  const pairingUrl = `https://127.0.0.1:${proxy.port}/pair`;
  const publicOrigin = new URL(pairingUrl).origin;
  const link = `${publicOrigin}/ask/synthetic.md`;
  const tls = { ca: readFileSync(cert, 'utf8') };
  const made = await cli(join(run, 'data'), 'pair', '--kind', 'agent', '--name', 'TLS remote reader');
  assert.equal(made.exit, 0, made.stderr);
  const code = JSON.parse(made.stdout);
  assert.equal(code.approval, 'pending');
  const redeem = () => fetch(pairingUrl, { method: 'POST', redirect: 'error', tls, body: JSON.stringify({ code: code.code, name: 'TLS remote reader' }) });
  assert.equal((await redeem()).status, 403);
  socket = createLocalSocket(`${backend.replace('http:', 'ws:')}/ws`);
  await new Promise<void>((done, fail) => {
    socket!.onopen = () => done();
    socket!.onerror = () => fail(new Error('Human RPC failed'));
  });
  assert.equal((await rpc<{ ok: boolean }>('device.pair.approve', { codeId: code.codeId })).ok, true);
  const paired = await redeem();
  assert.equal(paired.status, 200);
  const remote = await paired.json();
  const remoteData = join(run, 'remote-client');
  mkdirSync(remoteData, { mode: 0o700 });
  writeFileSync(join(remoteData, 'agent-read.credential'), JSON.stringify({ credential: remote.credential, origin: new URL(pairingUrl).origin }), { mode: 0o600 });
  const read = await cli(remoteData, 'read', link);
  const receipt = { pairedOverTls: true, backendHttp: true, cliExit: read.exit, cardRead: read.stdout.startsWith('# Plan the visit\n'), error: read.stderr };
  writeFileSync(join(run, 'evidence/tls-agent-read.json'), JSON.stringify(receipt, null, 2));
  assert.equal(read.exit, 0, read.stderr);
  assert.equal(receipt.cardRead, true);
  collector = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    collectorRequests += 1;
    return new Response('# Other origin', { headers: { 'content-type': 'text/markdown' } });
  } });
  const foreign = await cli(remoteData, 'read', `http://127.0.0.1:${collector.port}/ask/synthetic.md`);
  assert.equal(foreign.exit, 1);
  assert.equal(collectorRequests, 0);
  assert.equal((await fetch(`${publicOrigin}/ws`, { tls, headers: { authorization: `Bearer ${remote.credential}` } })).status, 401);
  assert.equal((await rpc<{ ok: boolean }>('device.revoke', { deviceId: remote.deviceId })).ok, true);
  const revoked = await cli(remoteData, 'read', link);
  assert.equal(revoked.exit, 1);
  assert(revoked.stderr.includes('401'));
  const human = readLocalCredential(join(run, 'data/local-rpc.credential'));
  assert.equal((await fetch(link, { tls, headers: { authorization: `Bearer ${human}` } })).status, 200);
  writeFileSync(join(run, 'evidence/tls-agent-read.json'), JSON.stringify({ ...receipt, passed: true, clientOrigin: publicOrigin, crossOriginRequests: collectorRequests, agentOtherRoute: 401, revoked: 401, humanRead: 200 }, null, 2));
} finally {
  socket?.close();
  collector?.stop(true);
  proxy?.stop(true);
  await app.cleanup();
  writeFileSync(join(run, 'evidence/tls-cleanup.json'), JSON.stringify({ daemonStopped: true, proxyStopped: true, collectorStopped: true }));
}
