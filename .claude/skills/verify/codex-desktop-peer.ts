import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';

export async function syntheticCodexDesktop(
  run: string,
  options: {
    active?: () => boolean;
    start: (request: { params: { turnStart: { request: { input: { text: string }[] } } } }) => string;
    steer?: () => string;
    dropReply?: (method: string) => boolean;
  }
) {
  mkdirSync(join(run, 'home/.codex/ipc'), { recursive: true });
  writeFileSync(join(run, 'bin/ps'), '#!/bin/sh\nprintf "%s\\n" /Applications/Codex.app/Contents/MacOS/Codex\n', { mode: 0o700 });
  writeFileSync(join(run, 'bin/open'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
  const sockets = new Set<Socket>();
  const peer = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        const response = request.method === 'initialize'
          ? { resultType: 'success', result: { clientId: 'synthetic-client' } }
          : request.method === 'thread-owner-discovery'
            ? { resultType: 'success', handledByClientId: 'synthetic-owner' }
            : request.method === 'thread-follower-start-turn'
              ? { resultType: 'success', result: { result: { turn: { id: options.start(request) } } } }
              : request.method === 'thread-follower-steer-turn' && options.active?.()
                ? { resultType: 'success', result: { result: { turnId: options.steer?.() ?? 'synthetic-turn' } } }
                : { resultType: 'error', error: 'NoActiveTurn' };
        if (options.dropReply?.(request.method)) { socket.destroy(); continue; }
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: request.requestId, ...response }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      }
    });
  });
  await new Promise<void>((done, fail) => { peer.once('error', fail); peer.listen(join(run, 'home/.codex/ipc/ipc.sock'), done); });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, fail) => peer.close((error) => error ? fail(error) : done()));
  };
}
