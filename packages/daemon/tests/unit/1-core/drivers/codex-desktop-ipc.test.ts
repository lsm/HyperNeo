import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCodexDesktopIpc } from '../../../../src/lib/drivers/codex-desktop-ipc';

interface Message {
  type: string;
  requestId: string;
  method?: string;
  sourceClientId?: string;
  targetClientId?: string;
  version?: number;
  response?: unknown;
}

describe('withCodexDesktopIpc', () => {
  let directory = '';
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  async function fixture(
    handle: (message: Message, socket: Socket, send: (response: object) => void) => void,
    initialization: object = { resultType: 'success', result: { clientId: 'neo-client' } }
  ) {
    directory = mkdtempSync(join(tmpdir(), 'codex-ipc-client-'));
    const path = join(directory, 'ipc.sock');
    const seen: Message[] = [];
    let resolveClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', resolveClosed);
      let buffer = Buffer.alloc(0);
      const send = (response: object) => {
        const body = Buffer.from(JSON.stringify(response));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        socket.write(header.subarray(0, 2));
        socket.write(Buffer.concat([header.subarray(2), body]));
      };
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
          const size = buffer.readUInt32LE(0);
          const message = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Message;
          buffer = buffer.subarray(4 + size);
          seen.push(message);
          if (message.method === 'initialize') {
            send({ type: 'response', requestId: message.requestId, ...initialization });
          } else {
            handle(message, socket, send);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));
    return { path, seen, closed };
  }

  test('correlates out-of-order fragmented replies and declines discovery requests', async () => {
    const pending: Message[] = [];
    let resolveDiscovery = () => {};
    const declinedDiscovery = new Promise<void>((resolve) => {
      resolveDiscovery = resolve;
    });
    const f = await fixture((message, _socket, send) => {
      if (message.type === 'client-discovery-response') resolveDiscovery();
      if (message.type !== 'request') return;
      pending.push(message);
      if (pending.length !== 2) return;
      send({ type: 'client-discovery-request', requestId: 'discovery-1' });
      send({ type: 'broadcast', method: 'client-status-changed' });
      for (const request of [...pending].reverse()) {
        send({
          type: 'response',
          requestId: request.requestId,
          resultType: 'success',
          handledByClientId: request.method,
        });
      }
    });
    const responses = await withCodexDesktopIpc(f.path, async ({ call }) => {
      const values = await Promise.all([
        call('thread-owner-discovery', { conversationId: 'thread-1' }, 1),
        call('thread-follower-interrupt-turn', { conversationId: 'thread-1' }, 4, 'owner-1'),
      ]);
      await declinedDiscovery;
      return values;
    });
    await f.closed;
    expect(responses.map((response) => response.handledByClientId)).toEqual([
      'thread-owner-discovery',
      'thread-follower-interrupt-turn',
    ]);
    expect(f.seen[0]).toMatchObject({
      type: 'request',
      method: 'initialize',
      version: 0,
      sourceClientId: 'initializing-client',
    });
    expect(f.seen[1]).toMatchObject({ sourceClientId: 'neo-client', version: 1 });
    expect(f.seen[2]).toMatchObject({
      sourceClientId: 'neo-client',
      targetClientId: 'owner-1',
      version: 4,
    });
    expect(f.seen).toContainEqual({
      type: 'client-discovery-response',
      requestId: 'discovery-1',
      response: { canHandle: false },
    });
  });

  test.each([
    { resultType: 'error', error: 'client rejected' },
    { resultType: 'success', result: {} },
  ])('rejects an invalid handshake and closes before invoking the caller: %j', async (reply) => {
    const f = await fixture(() => {}, reply);
    let invoked = false;
    await expect(
      withCodexDesktopIpc(f.path, async () => {
        invoked = true;
      })
    ).rejects.toThrow(reply.resultType === 'error' ? 'client rejected' : 'initialization failed');
    await f.closed;
    expect(invoked).toBe(false);
    expect(f.seen).toHaveLength(1);
  });

  test.each([0, 16 * 1024 * 1024 + 1])('rejects invalid frame length %i', async (size) => {
    const f = await fixture((_message, socket) => {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(size);
      socket.write(header);
    });
    await expect(
      withCodexDesktopIpc(f.path, ({ call }) => call('thread-owner-discovery', {}, 1))
    ).rejects.toThrow('Invalid Codex Desktop IPC frame');
    await f.closed;
  });

  test('rejects all outstanding requests when Desktop disconnects', async () => {
    const f = await fixture((_message, socket) => socket.destroy());
    const responses = await withCodexDesktopIpc(f.path, ({ call }) =>
      Promise.allSettled([call('first', {}, 1), call('second', {}, 1)])
    );
    expect(responses.map((response) => response.status)).toEqual(['rejected', 'rejected']);
  });

  test('closes the connection when the caller fails', async () => {
    const f = await fixture(() => {});
    await expect(
      withCodexDesktopIpc(f.path, async () => {
        throw new Error('operation failed');
      })
    ).rejects.toThrow('operation failed');
    await f.closed;
  });

  test('reports an unavailable socket without invoking the caller', async () => {
    directory = mkdtempSync(join(tmpdir(), 'codex-ipc-absent-'));
    let invoked = false;
    await expect(
      withCodexDesktopIpc(join(directory, 'missing.sock'), async () => {
        invoked = true;
      })
    ).rejects.toThrow();
    expect(invoked).toBe(false);
  });
});
