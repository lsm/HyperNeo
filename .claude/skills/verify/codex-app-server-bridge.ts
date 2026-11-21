import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, readFile, stat, symlink, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import type { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { startCodexAppServerBridge } from '../../../packages/daemon/src/lib/drivers/codex-app-server-bridge.ts';

const [phase, bridgePortText, runText] = process.argv.slice(2);
const run = resolve(runText);
const home = join(run, 'home');
const data = join(run, 'data');
const directory = join(data, 'codex-app-server-bridge');
const tokenFile = join(directory, 'token');
assert(['verify', 'listener', 'enabled', 'restart', 'busy', 'unusable'].includes(phase));
assert.equal(process.platform, 'darwin');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);

async function dial(target: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${target}`, { handshakeTimeout: 2000 });
  return new Promise<WebSocket | null>((done) => {
    socket.on('error', () => done(null));
    socket.once('open', () => done(socket));
  });
}

async function portIsOpen() {
  const socket = connect(port, '127.0.0.1');
  try {
    await once(socket, 'connect', { signal: AbortSignal.timeout(2000) });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error;
    return false;
  } finally {
    socket.destroy();
  }
}

const fixture = createServer();
const ws = new WebSocketServer({ server: fixture });
const appServerDirectory = join(home, '.codex', 'app-server-control');
await mkdir(appServerDirectory, { recursive: true });
const socketPath = join(appServerDirectory, 'app-server-control.sock');
let port = Number(bridgePortText);
if (phase === 'verify' || phase === 'listener') {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert(address && typeof address !== 'string');
  port = address.port;
  await new Promise<void>((done) => reservation.close(() => done()));
}
assert(port > 0 && port !== 8399);
fixture.listen(socketPath);
await once(fixture, 'listening');
let upstreamConnections = 0;
const targets: string[] = [];
fixture.on('connection', () => upstreamConnections++);
ws.on('connection', (client, request) => {
  targets.push(request.url ?? '');
  client.on('message', (payload, binary) => client.send(payload, { binary }));
});

const logs: string[] = [];
let unsubscribe: (() => void) | undefined;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let close: (() => Promise<void>) | undefined;
const blocker = phase === 'busy' ? createServer((_request, response) => response.end('occupied')) : null;
try {
  if (blocker) {
    blocker.listen(port, '127.0.0.1');
    await once(blocker, 'listening');
  }
  if (phase === 'listener') {
    close = await startCodexAppServerBridge(port);
  } else {
    const [{ createDaemonApp }, { getConfig }, { subscribeToStructuredLogs }] = await Promise.all([
      import('../../../packages/daemon/src/app.ts'),
      import('../../../packages/daemon/src/config.ts'),
      import('../../../packages/daemon/src/lib/logger.ts'),
    ]);
    unsubscribe = subscribeToStructuredLogs((event) => logs.push(JSON.stringify(event)));
    app = await createDaemonApp({
      config: getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db') }),
      standalone: true,
      verbose: true,
    });
    close = app.cleanup;
    assert.notEqual(app.server.port, 8399);
  }
  if (phase === 'verify') {
    assert.equal(await portIsOpen(), false);
    await assert.rejects(stat(tokenFile), { code: 'ENOENT' });
    assert(app);
    app.settingsManager.updateGlobalSettings({ codexAppServerBridge: { enabled: true, port } });
    assert.equal(await portIsOpen(), false);
    console.log(JSON.stringify({ disabledBoots: 1, tokenFiles: 0, liveActivation: 0 }));
  } else if (phase === 'busy') {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(await response.text(), 'occupied');
    assert(logs.some((entry) => entry.includes(`Codex bridge port ${port} is busy`)));
    console.log(JSON.stringify({ busyPortsReported: 1, previousListenersIntact: 1 }));
  } else if (phase === 'unusable') {
    assert.equal(await portIsOpen(), false);
    assert.equal(upstreamConnections, 0);
    assert(logs.some((entry) => entry.includes('Check ownership and permissions')));
    console.log(JSON.stringify({ unsafeTokenFilesRejected: 1, upstreamConnections }));
  } else {
    const token = await readFile(tokenFile, 'utf8');
    assert.equal(token.length, 43);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    if (phase === 'restart') assert((await Bun.file(join(run, 'first-token')).text()) === token);
    else if (phase === 'enabled') await Bun.write(join(run, 'first-token'), token);
    const wrong = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
    assert.equal(await dial('/rpc'), null);
    assert.equal(await dial(`/rpc?token=${wrong}`), null);
    assert.equal(upstreamConnections, 0);
    const client = await dial(`/rpc?token=${token}`);
    assert(client, 'Authorized WebSocket must connect');
    const reply = once(client, 'message', { signal: AbortSignal.timeout(2000) });
    client.send('bridge proof');
    assert.equal(String((await reply)[0]), 'bridge proof');
    assert(targets.length === 1 && targets[0] === '/', 'Upstream should receive only the root path');
    assert.equal(upstreamConnections, 1);
    const closed = once(client, 'close', { signal: AbortSignal.timeout(5000) });
    await close();
    close = undefined;
    await closed;
    assert.equal(await portIsOpen(), false);
    if (phase === 'listener') {
      await chmod(directory, 0o755);
      await chmod(tokenFile, 0o644);
      close = await startCodexAppServerBridge(port);
      assert((await readFile(tokenFile, 'utf8')) === token);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
      await assert.rejects(startCodexAppServerBridge(port), /is busy/);
      await close();
      close = undefined;
      await unlink(tokenFile);
      await symlink(join(run, 'missing-token'), tokenFile);
      await assert.rejects(startCodexAppServerBridge(port), /Check ownership and permissions/);
      assert.equal(await portIsOpen(), false);
      console.log(JSON.stringify({ tokenReused: 1, modesTightened: 2, busyPortsReported: 1, unsafeFilesRejected: 1 }));
    }
    if (app) assert.equal(logs.some((entry) => entry.includes(token)), false);
    console.log(JSON.stringify({ phase, unauthorized: 2, exchanges: 1, closedClients: 1, ...(app && { tokenLogHits: 0 }) }));
  }
} finally {
  try {
    await close?.();
  } finally {
    unsubscribe?.();
    if (blocker?.listening) await new Promise<void>((done) => blocker.close(() => done()));
    for (const client of ws.clients) client.terminate();
    ws.close();
    await new Promise<void>((done) => fixture.close(() => done()));
    await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

if (phase === 'verify') {
  for (const childPhase of ['enabled', 'restart', 'busy', 'unusable']) {
    if (childPhase === 'restart') {
      await chmod(directory, 0o755);
      await chmod(tokenFile, 0o644);
    }
    if (childPhase === 'unusable') {
      await unlink(tokenFile);
      await symlink(join(run, 'first-token'), tokenFile);
    }
    const result = Bun.spawnSync(['bun', import.meta.path, childPhase, String(port), run], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    console.log(JSON.stringify({ childPhase, exitCode: result.exitCode }));
    assert.equal(result.exitCode, 0);
  }
}
