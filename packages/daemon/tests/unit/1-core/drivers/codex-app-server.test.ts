import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { connectCodexAppServer } from '../../../../src/lib/drivers/codex-app-server';

describe('connectCodexAppServer', () => {
  let dir: string;
  let server: Server;
  let sockets: WebSocketServer;

  afterEach(async () => {
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  async function listen(): Promise<{ path: string; seen: string[] }> {
    dir = mkdtempSync(join(tmpdir(), 'codex-app-server-'));
    const path = join(dir, 'control.sock');
    const seen: string[] = [];
    server = createServer();
    sockets = new WebSocketServer({ server });
    sockets.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data));
        seen.push(message.method);
        if (message.id === undefined) return;
        socket.send(
          JSON.stringify(
            message.method === 'thread/start'
              ? { id: message.id, result: { thread: { id: 'th1' } } }
              : message.method === 'initialize'
                ? { id: message.id, result: {} }
                : { id: message.id, error: { message: 'no such method' } }
          )
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return { path, seen };
  }

  test('initializes, answers calls and turns JSON-RPC errors into throws', async () => {
    const { path, seen } = await listen();
    const client = await connectCodexAppServer(path);
    try {
      expect(await client.call('thread/start', { cwd: '/focus' })).toEqual({
        thread: { id: 'th1' },
      });
      await expect(client.call('thread/fly', {})).rejects.toThrow('thread/fly');
      expect(seen).toEqual(['initialize', 'initialized', 'thread/start', 'thread/fly']);
    } finally {
      client.close();
    }
  });

  test('fails to connect when nothing listens on the socket', async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-app-server-'));
    server = createServer();
    sockets = new WebSocketServer({ noServer: true });
    server.listen(join(dir, 'other.sock'));
    await expect(connectCodexAppServer(join(dir, 'missing.sock'))).rejects.toThrow();
  });
});
