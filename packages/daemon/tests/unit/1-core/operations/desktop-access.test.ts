import { afterEach, beforeEach, expect, test } from 'vitest';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopAccessOperation } from '../../../../src/lib/desktop/access-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';

let root: string;
let server: Server;
let requests: Record<string, unknown>[];
let reply: (callId: string) => unknown;
const neo: OperationCaller = { source: 'mcp', sessionId: 'neo', role: 'neo' };
const request = (app: string, caller = neo, dataDir = root) =>
  invokeOperation(
    createOperationRegistry([createDesktopAccessOperation({ dataDir })]),
    'desktop.access.request',
    { app },
    caller
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-access-'));
  await mkdir(join(root, 'desktop'));
  requests = [];
  reply = (callId) => ({ ok: true, result: { call_id: callId, value: { bundle_id: 'x' } } });
  server = createServer((socket) => {
    let line = '';
    socket.on('data', (chunk) => {
      line += chunk;
      if (!line.includes('\n')) return;
      const body = JSON.parse(line);
      requests.push(body);
      socket.end(JSON.stringify(reply(body.callId)) + '\n');
    });
  });
  server.listen(join(root, 'desktop/control.sock'));
  await once(server, 'listening');
});
afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
});

test('an allowed app returns ok after one resolve request for that bundle id', async () => {
  expect(await request('com.apple.Safari')).toMatchObject({
    kind: 'completed',
    value: { ok: true, bundleId: 'com.apple.Safari' },
  });
  expect(requests).toEqual([
    expect.objectContaining({
      action: 'resolve',
      tool: 'launch_app',
      arguments: { bundle_id: 'com.apple.Safari' },
    }),
  ]);
});

test('a declined app returns the reason with what Neo should do next', async () => {
  reply = (callId) => ({
    ok: true,
    result: { call_id: callId, reason: 'owner_declined', bundle_id: 'com.apple.Safari' },
  });
  const outcome = await request('com.apple.Safari');
  expect(outcome).toMatchObject({
    kind: 'completed',
    value: { ok: false, bundleId: 'com.apple.Safari' },
  });
  expect(JSON.stringify(outcome)).toContain('owner_declined: The human declined');
});

test('a missing desktop app is reported as not connected', async () => {
  const outcome = await request('com.apple.Safari', neo, join(root, 'absent'));
  expect(JSON.stringify(outcome)).toContain('desktop_app_not_connected');
  expect(requests).toHaveLength(0);
});

test('only Neo may request access', async () => {
  expect(
    await request('com.apple.Safari', { ...neo, sessionId: 'worker-a', role: 'universal_read' })
  ).toMatchObject({
    kind: 'completed',
    value: { ok: false, reason: expect.stringContaining('neo_only') },
  });
  expect(requests).toHaveLength(0);
});
