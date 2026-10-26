import { connect } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { MessageHubRouter } from '../../../packages/shared/src/message-hub/router.ts';
import { WebSocketServerTransport } from '../../../packages/daemon/src/lib/websocket-server-transport.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import type { SessionManager } from '../../../packages/daemon/src/lib/session-manager.ts';
import { createBunServer } from '../../../packages/daemon/src/lib/runtime-server/bun-backend.ts';

const mode = process.argv[2];
const run = process.argv[3];
const router = new MessageHubRouter();
const transport = new WebSocketServerTransport({ router });
const handlers = createWebSocketHandlers(transport, {} as SessionManager);
let drops = 0;
let resyncs = 0;
let maxBufferedBytes = 0;
let maxQueuedMessages = 0;
let received = Buffer.alloc(0);
const count = 384;
const payload = 'x'.repeat(64 * 1024);
const server = await createBunServer({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req, upgrade) {
    return upgrade(req, { connectionSessionId: 'global' });
  },
  websocket: {
    ...handlers,
    open(ws) {
      handlers.open(ws);
      const send = ws.send.bind(ws);
      ws.send = (data) => {
        const result = send(data);
        if (result === 0) drops++;
        maxBufferedBytes = Math.max(
          maxBufferedBytes,
          (ws as unknown as { getBufferedAmount(): number }).getBufferedAmount()
        );
        return result;
      };
      const close = ws.close.bind(ws);
      ws.close = (code, reason) => {
        if (code === 1011) resyncs++;
        close(code, reason);
      };
      setTimeout(() => {
        for (let i = 0; i < count; i++) {
          router.broadcast({ type: 'EVENT', method: 'proof.burst', id: `${i}`, sessionId: 'global', data: { payload } });
          maxQueuedMessages = Math.max(maxQueuedMessages, transport.getClientQueueSize((ws.data as { clientId: string }).clientId));
        }
      }, 50);
    },
  },
});
const socket = connect(server.port, '127.0.0.1');
try {
  socket.on('data', (data) => { received = Buffer.concat([received, data]); });
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await new Promise((resolve) => setTimeout(resolve, 25));
  socket.pause();
  await new Promise((resolve) => setTimeout(resolve, 500));
  socket.resume();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const start = received.indexOf('\r\n\r\n') + 4;
  const ids: string[] = [];
  let offset = start;
  while (offset + 2 <= received.length) {
    const opcode = received[offset] & 15;
    let size = received[offset + 1] & 127;
    let header = 2;
    if (size === 126) { size = received.readUInt16BE(offset + 2); header = 4; }
    else if (size === 127) { size = Number(received.readBigUInt64BE(offset + 2)); header = 10; }
    if (offset + header + size > received.length) break;
    if (opcode === 1) ids.push(JSON.parse(received.subarray(offset + header, offset + header + size).toString()).id);
    offset += header + size;
  }
  const evidence = { mode, count, messageBytes: Buffer.byteLength(JSON.stringify({ type: 'EVENT', method: 'proof.burst', id: '383', sessionId: 'global', data: { payload } })), drops, resyncs, maxBufferedBytes, maxQueuedMessages, maxQueuedBytesUpperBound: maxQueuedMessages * (payload.length + 100), delivered: ids.length, ordered: ids.every((id, i) => id === `${i}`) };
  await mkdir(`${run}/evidence`, { recursive: true });
  await writeFile(`${run}/evidence/backpressure.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  if (mode === 'baseline' ? drops === 0 : drops !== 0 || resyncs !== 0 || ids.length !== count || !evidence.ordered) throw new Error('Slow-client proof failed');
} finally {
  socket.destroy();
  server.stop(true);
  await transport.close();
}
