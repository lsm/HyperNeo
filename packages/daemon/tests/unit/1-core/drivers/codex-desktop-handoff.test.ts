import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodexDesktopTurn } from '../../../../src/lib/drivers/codex-desktop-handoff';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';

const request = {
  threadId: 'thread-1',
  input: [{ type: 'text', text: 'Opening message' }],
  model: 'gpt-6.1-sol',
  effort: 'medium',
};
type Message = {
  type: string;
  requestId: string;
  method: string;
  version: number;
  sourceClientId: string;
  targetClientId?: string;
  params: Record<string, unknown>;
};

describe('startCodexDesktopTurn', () => {
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
    options: { turnError?: string; openError?: boolean; disconnect?: boolean } = {}
  ) {
    directory = mkdtempSync(join(tmpdir(), 'codex-desktop-ipc-'));
    const path = join(directory, 'ipc.sock');
    const seen: Message[] = [];
    const launched: string[][] = [];
    let discoveries = 0;
    let opened = false;
    server = createServer((socket) => {
      sockets.add(socket);
      let buffer = Buffer.alloc(0);
      const send = (message: object) => {
        const body = Buffer.from(JSON.stringify(message));
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
          if (message.type !== 'request') continue;
          if (options.disconnect && message.method !== 'initialize') {
            socket.destroy();
            continue;
          }
          const error =
            message.method === 'thread-owner-discovery' && ++discoveries === 1
              ? 'no-client-found'
              : message.method === 'thread-follower-start-turn'
                ? options.turnError
                : undefined;
          if (message.method === 'thread-owner-discovery') expect(opened).toBe(true);
          send({
            type: 'broadcast',
            method: 'client-status-changed',
            params: {},
          });
          send({
            type: 'response',
            requestId: message.requestId,
            method: message.method,
            resultType: error ? 'error' : 'success',
            error,
            handledByClientId: 'desktop-owner',
            result:
              message.method === 'initialize'
                ? { clientId: 'neo-client' }
                : message.method === 'thread-follower-start-turn'
                  ? { result: { turn: { id: 'turn-1' } } }
                  : {},
          });
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));
    const spawn: SpawnFn = (args) => {
      launched.push(args);
      opened = true;
      return {
        stdout: null,
        stderr: new Response(options.openError ? 'app missing' : '').body,
        exited: Promise.resolve(options.openError ? 1 : 0),
        exitCode: 0,
        kill: () => {},
      };
    };
    return { path, spawn, seen, launched };
  }

  test('waits for desktop ownership and targets its first turn with the selected model and effort', async () => {
    const f = await fixture();
    await startCodexDesktopTurn(f.path, f.spawn, 'thread-1', request);
    expect(f.launched).toEqual([['open', '-g', 'codex://threads/thread-1']]);
    expect(f.seen.map((message) => message.method)).toEqual([
      'initialize',
      'thread-owner-discovery',
      'thread-owner-discovery',
      'thread-follower-start-turn',
    ]);
    expect(f.seen.at(-1)).toMatchObject({
      version: 2,
      sourceClientId: 'neo-client',
      targetClientId: 'desktop-owner',
      params: {
        conversationId: 'thread-1',
        turnStart: { request, context: { inheritThreadSettings: false } },
      },
    });
  });

  test('does not retry an opening turn when the owner rejects it', async () => {
    const f = await fixture({ turnError: 'owner is closing' });
    await expect(startCodexDesktopTurn(f.path, f.spawn, 'thread-1', request)).rejects.toThrow(
      'owner is closing'
    );
    expect(
      f.seen.filter((message) => message.method === 'thread-follower-start-turn')
    ).toHaveLength(1);
  });

  test('does not deliver input when the desktop cannot be opened', async () => {
    const f = await fixture({ openError: true });
    await expect(startCodexDesktopTurn(f.path, f.spawn, 'thread-1', request)).rejects.toThrow(
      'app missing'
    );
    expect(f.seen.map((message) => message.method)).toEqual(['initialize']);
  });

  test('fails promptly if the desktop disconnects during handoff', async () => {
    const f = await fixture({ disconnect: true });
    await expect(startCodexDesktopTurn(f.path, f.spawn, 'thread-1', request)).rejects.toThrow(
      'closed the handoff'
    );
    expect(f.seen.map((message) => message.method)).toEqual([
      'initialize',
      'thread-owner-discovery',
    ]);
  });
});
