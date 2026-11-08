import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] ?? 0);
const transcript = process.argv[3];
const finalizeDelayMs = Number(process.argv[4] ?? 0);
const server = new WebSocketServer({ port });
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
  let bytes = 0;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  socket.on('close', () => clearTimeout(finalTimer));
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const finish = () => {
        socket.send(result(transcript ?? `heard ${bytes} bytes`, true));
        socket.close(1000);
      };
      if (finalizeDelayMs) finalTimer = setTimeout(finish, finalizeDelayMs);
      else finish();
      return;
    }
    bytes += data.length;
    socket.send(result(transcript ?? `heard ${bytes} bytes`, false));
  });
});
