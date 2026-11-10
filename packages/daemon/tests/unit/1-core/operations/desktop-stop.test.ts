import { afterEach, beforeEach, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopStopOperation } from '../../../../src/lib/desktop/stop-operation.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

const identity = { seconds: 1, microseconds: 2 };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const driverSource = `
const fs = require('node:fs');
const net = require('node:net');
const [socket, events, ignore] = process.argv.slice(1);
const server = net.createServer(client => client.end());
process.on('SIGTERM', () => {
  fs.appendFileSync(events, 'SIGTERM\\n');
  if (ignore === 'true') return;
  server.close(() => process.exit(0));
});
server.listen(socket, () => process.stdout.write('ready\\n'));
`;
let root: string;
let directory: string;
let socketPath: string;
let events: string;
let app: Server;
let connections: Set<Socket>;
let driver: ChildProcess;
let exited: Promise<unknown[]>;
let stopRequests: number;
let appAnswers: boolean;
let beforeAppReply: (() => Promise<void>) | undefined;
let currentIdentity: typeof identity;
let identityReads: number;
let changeBeforeKill: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-'));
  directory = join(root, 'desktop/workers/worker-a');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  socketPath = join(root, 'driver.sock');
  events = join(root, 'driver-events');
  stopRequests = 0;
  appAnswers = true;
  beforeAppReply = undefined;
  currentIdentity = identity;
  identityReads = 0;
  changeBeforeKill = false;
  connections = new Set();
  app = createServer((connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    connection.on('data', async (data) => {
      expect(JSON.parse(String(data))).toEqual({ action: 'stop', worker: 'worker-a' });
      expect(existsSync(join(directory, 'stopped'))).toBe(true);
      stopRequests++;
      await beforeAppReply?.();
      if (appAnswers)
        connection.end(JSON.stringify({ ok: true, result: { state: 'stopped' } }) + '\n');
    });
  });
  app.listen(join(root, 'desktop/control.sock'));
  await once(app, 'listening');
});
afterEach(async () => {
  if (driver && driver.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
  if (exited) await exited;
  for (const connection of connections) connection.destroy();
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function start(ignoreTerm = false) {
  driver = spawn(process.execPath, ['-e', driverSource, socketPath, events, String(ignoreTerm)], {
    env: { HOME: root, NODE_ENV: 'test', PATH: process.env.PATH ?? '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(driver, 'exit');
  const [ready] = await once(driver.stdout!, 'data');
  expect(String(ready)).toBe('ready\n');
  await chmod(socketPath, 0o600);
  await writeFile(
    join(directory, 'driver.json'),
    JSON.stringify({ pid: driver.pid, startedAt: identity, socket: socketPath }),
    { mode: 0o600 }
  );
}
async function stop(caller = human) {
  const registry = createOperationRegistry([
    createDesktopStopOperation({
      dataDir: root,
      readIdentity: async (pid: number) => {
        expect(pid).toBe(driver.pid);
        identityReads++;
        return changeBeforeKill && identityReads > 1
          ? { ...identity, microseconds: 3 }
          : currentIdentity;
      },
    }),
  ]);
  return invokeOperation(registry, 'desktop.stop', { worker: 'worker-a' }, caller);
}

test('stop succeeds only when PID and socket are gone', async () => {
  await start(true);
  driver.kill('SIGKILL');
  await exited;
  expect(existsSync(socketPath)).toBe(true);
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stop_unconfirmed' } });
  await unlink(socketPath);
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stopped' } });
});
test('a driver ignoring TERM is killed', async () => {
  await start(true);
  const started = Date.now();
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stop_unconfirmed' } });
  expect(driver.signalCode).toBe('SIGKILL');
  await exited;
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(await readFile(events, 'utf8')).toBe('SIGTERM\n');
  expect(stopRequests).toBe(1);
  expect(existsSync(socketPath)).toBe(true);
});
test('stop works when the app does not answer', async () => {
  await start();
  appAnswers = false;
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stopped' } });
  await exited;
  expect(driver.exitCode).toBe(0);
  expect(existsSync(socketPath)).toBe(false);
  expect(stopRequests).toBe(1);
});
test('a different process start identity is never signalled', async () => {
  await start();
  currentIdentity = { ...identity, microseconds: 3 };
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stop_unconfirmed' } });
  expect(driver.exitCode).toBeNull();
  expect(driver.signalCode).toBeNull();
  expect(existsSync(events)).toBe(false);
  expect(existsSync(join(directory, 'stopped'))).toBe(true);
});
test('only human local RPC callers can stop a driver', async () => {
  await start();
  for (const caller of [
    { source: 'mcp', role: 'neo' },
    { source: 'rpc', principal: 'remote' },
    { source: 'rpc', principal: 'local', device: { deviceId: 'test-agent', kind: 'agent' } },
    { source: 'rpc', principal: 'local', device: { deviceId: 'test-relay', kind: 'relay' } },
  ] as OperationCaller[]) {
    expect(await stop(caller)).toMatchObject({ kind: 'failed', code: 'forbidden' });
  }
  expect(stopRequests).toBe(0);
  expect(existsSync(join(directory, 'stopped'))).toBe(false);
  expect(existsSync(events)).toBe(false);
});

test('identity is checked again before KILL', async () => {
  await start(true);
  changeBeforeKill = true;
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stop_unconfirmed' } });
  expect(identityReads).toBe(2);
  expect(driver.exitCode).toBeNull();
  expect(driver.signalCode).toBeNull();
  expect(await readFile(events, 'utf8')).toBe('SIGTERM\n');
});
test('an unprotected driver record cannot authorize a signal', async () => {
  await start();
  await chmod(join(directory, 'driver.json'), 0o644);
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stop_unconfirmed' } });
  expect(identityReads).toBe(0);
  expect(driver.signalCode).toBeNull();
  expect(existsSync(events)).toBe(false);
  expect(existsSync(join(directory, 'stopped'))).toBe(true);
});

test('an incomplete start without a reliable record remains unconfirmed', async () => {
  await start();
  const marker = join(directory, 'starting');
  await mkdir(marker, { mode: 0o700 });
  await unlink(join(directory, 'driver.json'));
  await mkdir(join(directory, 'driver.json'));
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stop_unconfirmed' } });
  expect(existsSync(marker)).toBe(true);
  expect(identityReads).toBe(0);
  expect(driver.exitCode).toBeNull();
  expect(existsSync(events)).toBe(false);
});

test('the app can complete graceful shutdown before daemon escalation', async () => {
  await start();
  let signalledBeforeAppReply = false;
  beforeAppReply = async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    signalledBeforeAppReply = existsSync(events);
    driver.kill('SIGTERM');
    await exited;
  };
  expect(await stop()).toMatchObject({ kind: 'completed', value: { state: 'stopped' } });
  expect(signalledBeforeAppReply).toBe(false);
  expect(identityReads).toBe(0);
  expect(driver.exitCode).toBe(0);
  expect(existsSync(socketPath)).toBe(false);
});
