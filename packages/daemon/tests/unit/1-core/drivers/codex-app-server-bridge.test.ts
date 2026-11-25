import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { startCodexAppServerBridge } from '../../../../src/lib/drivers/codex-app-server-bridge.ts';
import { codexAppServerSocketPath } from '../../../../src/lib/drivers/worker-directories.ts';

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('startCodexAppServerBridge', () => {
  const token = 'a'.repeat(43);
  let root: string;
  let directory: string;
  let port: number;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'hnb-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('HYPERNEO_DATA_DIR', root);
    directory = join(root, 'codex-app-server-bridge');

    const reservation = createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP test port');
    port = address.port;
    await closeServer(reservation);
  });

  afterEach(async () => {
    try {
      await stop?.();
    } finally {
      stop = undefined;
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  function dial(target: string) {
    return new WebSocket(`ws://127.0.0.1:${port}${target}`, { handshakeTimeout: 2000 });
  }

  test('gates access before dialing upstream and forwards authorized frames without the token', async () => {
    const tokenFile = join(directory, 'token');
    await mkdir(directory);
    await writeFile(tokenFile, token);
    await chmod(directory, 0o755);
    await chmod(tokenFile, 0o644);

    const path = codexAppServerSocketPath();
    await mkdir(dirname(path), { recursive: true });
    const upstream = createServer();
    const websocket = new WebSocketServer({ server: upstream });
    let connections = 0;
    const rootTargets: boolean[] = [];
    upstream.on('connection', () => connections++);
    websocket.on('connection', (socket, request) => {
      rootTargets.push(request.url === '/');
      socket.on('message', (payload) => socket.send(payload));
    });
    upstream.listen(path);
    await once(upstream, 'listening');

    try {
      stop = await startCodexAppServerBridge(port);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);

      for (const target of ['/rpc', `/rpc?token=${'b'.repeat(43)}`]) {
        const client = dial(target);
        try {
          await expect(once(client, 'open')).rejects.toMatchObject({ code: 'ECONNRESET' });
        } finally {
          client.terminate();
        }
      }
      expect(connections).toBe(0);

      const client = dial(`/rpc?token=${token}`);
      try {
        await once(client, 'open');
        const reply = once(client, 'message', { signal: AbortSignal.timeout(2000) });
        client.send('forwarded');
        expect(String((await reply)[0])).toBe('forwarded');
        expect(connections).toBe(1);
        expect(rootTargets).toEqual([true]);
      } finally {
        client.terminate();
      }
    } finally {
      for (const client of websocket.clients) client.terminate();
      websocket.close();
      upstream.closeAllConnections();
      await closeServer(upstream);
    }
  });

  test('reports an unreachable app-server and keeps serving', async () => {
    const unreachable = vi.fn();
    stop = await startCodexAppServerBridge(port, () => Buffer.from(token), unreachable);
    for (const times of [1, 2]) {
      const client = dial(`/rpc?token=${token}`);
      await expect(once(client, 'open')).rejects.toBeDefined();
      client.terminate();
      await vi.waitFor(() => expect(unreachable).toHaveBeenCalledTimes(times));
    }
  });

  test.each(['file', 'directory'] as const)('refuses a symlinked token %s', async (kind) => {
    const target = join(root, 'target');
    if (kind === 'file') {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(target, token, { mode: 0o600 });
      await symlink(target, join(directory, 'token'));
    } else {
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, 'token'), token, { mode: 0o600 });
      await symlink(target, directory);
    }

    const start = async () => {
      stop = await startCodexAppServerBridge(port);
    };
    await expect(start()).rejects.toThrow('Check ownership and permissions');
  });
});
