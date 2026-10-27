import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

const REPO = process.env.VERIFY_REPO ?? resolve(import.meta.dir, '../../..');
const RUN = resolve(process.argv[2] ?? '.');
const STALL_MS = 2_000;
const MAX_PONG_GAP_MS = 1_000;

if (process.argv[3] === 'child') {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((done) => server.once('listening', done));
  process.stdout.write(`PORT ${(server.address() as { port: number }).port}\n`);
  const pongs: number[] = [];
  let last = Date.now();
  server.on('connection', (socket: WebSocket) => {
    const pinger = setInterval(() => socket.ping(), 300);
    socket.on('pong', () => {
      pongs.push(Date.now() - last);
      last = Date.now();
    });
    socket.on('close', () => clearInterval(pinger));
  });
  process.on('SIGTERM', () => {
    process.stdout.write(`PONGS ${JSON.stringify(pongs)}\n`, () => process.exit(0));
    setTimeout(() => process.exit(0), 1_000);
  });
} else {
  mkdirSync(join(RUN, 'evidence'), { recursive: true });
  const child = spawn(process.execPath, [import.meta.path, RUN, 'child'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let port = 0;
  let pongs: number[] = [];
  child.stdout.on('data', (data: Buffer) => {
    const portMatch = /PORT (\d+)/.exec(data.toString());
    if (portMatch) port = Number(portMatch[1]);
    const pongMatch = /PONGS (.*)/.exec(data.toString());
    if (pongMatch) pongs = JSON.parse(pongMatch[1]);
  });
  const { VoiceStream } = await import(
    `${REPO}/packages/daemon/src/lib/voice/stream-relay.ts`
  );
  for (let index = 0; index < 50 && !port; index++) {
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!port) throw new Error('stub ASR server never reported a port');
  const started = await VoiceStream.start('stall-proof', {
    voice: () => ({
      enabled: true,
      endpoint: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
      model: 'm',
      streamEndpoint: `ws://127.0.0.1:${port}/v1/listen`,
      allowPrivateNetwork: true,
    }),
    transcribeWav: async () => ({ action: 'transcribed', text: 'batch' }),
    push: () => {},
  });
  if ('error' in started) throw new Error(started.error);
  await new Promise((done) => setTimeout(done, 800));
  const stallStarted = Date.now();
  while (Date.now() - stallStarted < STALL_MS) execSync('true');
  await new Promise((done) => setTimeout(done, 800));
  started.stream.close();
  await new Promise((done) => setTimeout(done, 300));
  child.kill('SIGTERM');
  await new Promise((done) => setTimeout(done, 300));
  const maxGap = Math.max(...pongs, 0);
  const result = {
    via: started.via,
    stallMs: STALL_MS,
    pongGaps: pongs,
    maxPongGapMs: maxGap,
    passed: started.via === 'streaming' && pongs.length > 0 && maxGap < MAX_PONG_GAP_MS,
  };
  writeFileSync(join(RUN, 'evidence', 'voice-relay-stall.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 2);
}
