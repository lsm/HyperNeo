import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 0);
const transcript = process.argv[3];
const finalizeDelayMs = Number(process.argv[4] ?? 0);
const numbered = process.argv[5] === '--numbered';
let utterances = 0;
const cancelled: number[] = [];
const words = (id: number, bytes: number) =>
  numbered ? `${transcript ?? 'Transcript'} ${id}.` : (transcript ?? `heard ${bytes} bytes`);
const http = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/fixture/status') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ utterances, cancelled }));
    return;
  }
  const id = ++utterances;
  let bytes = 0;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  response.on('close', () => {
    if (!response.writableEnded) cancelled.push(id);
    clearTimeout(finalTimer);
  });
  request.on('data', (chunk) => {
    bytes += chunk.length;
  });
  request.on('end', () => {
    if (response.destroyed) return;
    const finish = () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ text: words(id, bytes) }));
    };
    if (finalizeDelayMs) finalTimer = setTimeout(finish, finalizeDelayMs);
    else finish();
  });
});
const server = new WebSocketServer({ server: http });
const result = (transcript: string, isFinal: boolean) =>
  JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    channel: { alternatives: [{ transcript }] },
  });
server.on('listening', () => {
  const address = server.address() as { port: number };
  console.log(`stub Deepgram-style ASR ready on ws://127.0.0.1:${address.port}/v1/listen`);
});
server.on('connection', (socket) => {
  const id = ++utterances;
  let bytes = 0;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  socket.on('close', () => clearTimeout(finalTimer));
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const finish = () => {
        socket.send(result(words(id, bytes), true));
        socket.close(1000);
      };
      if (finalizeDelayMs) finalTimer = setTimeout(finish, finalizeDelayMs);
      else finish();
      return;
    }
    bytes += data.length;
    socket.send(result(words(id, bytes), false));
  });
});
http.listen(port, '127.0.0.1');
