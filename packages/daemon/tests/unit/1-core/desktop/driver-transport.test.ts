import { afterEach, beforeEach, expect, test } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDriverTransport } from '../../../../src/lib/desktop/driver-transport.ts';
import { createDesktopProxy } from '../../../../src/lib/desktop/mcp-proxy.ts';

let root: string;
let server: Server;
let connections: Set<Socket>;
let requests: Record<string, unknown>[];
let control: Socket | undefined;
let transport: ReturnType<typeof createDriverTransport>;
let malformed: boolean;
let dropCall: boolean;
const result = { content: [{ type: 'text', text: 'synthetic readonly window \u{1f5d7}' }] };
const binding = {
  todo_id: '10000000-0000-4000-8000-000000000001',
  worker_id: 'worker-a',
  driver_instance_id: '123-456-789',
  target_app_id: null,
  socket: '',
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dm-'));
  binding.socket = join(root, 'd.sock');
  requests = [];
  connections = new Set();
  control = undefined;
  malformed = false;
  dropCall = false;
  transport = createDriverTransport();
  server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      const request = JSON.parse(data.trim());
      requests.push(request);
      if (request.method === 'session_begin') {
        control = socket;
        socket.write('{"ok":true}\n');
      } else if (dropCall) {
        socket.destroy();
      } else if (malformed) {
        socket.end('not-json\n');
      } else {
        const reply = Buffer.from(JSON.stringify({ ok: true, result }) + '\n');
        const split = reply.indexOf(Buffer.from('\u{1f5d7}')) + 1;
        socket.write(reply.subarray(0, split));
        setTimeout(() => socket.end(reply.subarray(split)), 20);
      }
    });
  });
  server.listen(binding.socket);
  await once(server, 'listening');
});
afterEach(async () => {
  transport.close();
  for (const socket of connections) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test('allowed readonly call passes the gate and reaches the worker socket', async () => {
  const audit: string[] = [];
  const proxy = createDesktopProxy({
    binding: async () => binding,
    dispatch: transport.dispatch,
    authorize: async () => ({ pid: 42, window_id: 7 }),
    audit: (line) => {
      audit.push(line);
    },
  });
  expect(await proxy.call('list_windows', { pid: 42 })).toEqual(result);
  expect(requests).toEqual([
    { method: 'session_begin', session_id: 'worker-a' },
    {
      method: 'call',
      name: 'list_windows',
      args: { pid: 42, session: 'worker-a' },
      session_id: 'worker-a',
    },
  ]);
  expect(JSON.parse(audit[0])).toMatchObject({ decision: 'allowed', upstream_dispatched: true });
  const closed = once(control!, 'close');
  transport.close();
  await closed;
});
test('refused name opens no driver connection', async () => {
  const proxy = createDesktopProxy({
    binding: async () => binding,
    dispatch: transport.dispatch,
    authorize: async () => ({ pid: 42, window_id: 7 }),
    audit: () => {},
  });
  expect(await proxy.call('run_script', {})).toMatchObject({ isError: true });
  expect(connections.size).toBe(0);
  expect(requests).toEqual([]);
});
test('concurrent calls share one lifecycle connection', async () => {
  expect(
    await Promise.all([
      transport.dispatch(binding, 'list_windows', {}),
      transport.dispatch(binding, 'list_windows', {}),
    ])
  ).toEqual([result, result]);
  expect(requests.filter((row) => row.method === 'session_begin')).toHaveLength(1);
});
test('a driver instance change is refused without reconnecting', async () => {
  await transport.dispatch(binding, 'list_windows', {});
  await expect(
    transport.dispatch({ ...binding, driver_instance_id: 'other' }, 'list_windows', {})
  ).rejects.toThrow();
  expect(requests).toHaveLength(2);
});
test('control loss closes the transport and later calls do not reconnect', async () => {
  await transport.dispatch(binding, 'list_windows', {});
  control!.destroy();
  await once(control!, 'close');
  await transport.closed;
  await expect(transport.dispatch(binding, 'list_windows', {})).rejects.toThrow();
  expect(requests).toHaveLength(2);
});
test('malformed and disconnected upstream replies fail closed', async () => {
  malformed = true;
  await expect(transport.dispatch(binding, 'list_windows', {})).rejects.toThrow();
  transport.close();
  transport = createDriverTransport();
  malformed = false;
  dropCall = true;
  await expect(transport.dispatch(binding, 'list_windows', {})).rejects.toThrow();
});
