const port = process.env.VERIFY_PORT;
const asrPort = process.argv[2];
if (!port || !asrPort) {
  console.error('usage: VERIFY_PORT=<port> bun voice.ts <stub-asr-port>');
  process.exit(2);
}
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const pending = new Map<string, (value: unknown) => void>();
const texts: unknown[] = [];
ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === 'EVENT' && message.method === 'voice.stream.text') texts.push(message.data);
  const done = pending.get(message.requestId ?? message.id);
  if (done) done(message.error ? { error: message.error } : message.data);
};
const call = (method: string, data: unknown) =>
  new Promise<unknown>((resolve) => {
    const id = crypto.randomUUID();
    pending.set(id, resolve);
    ws.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method,
        data,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
await call('settings.global.update', {
  updates: {
    voice: {
      enabled: true,
      endpoint: `http://127.0.0.1:${asrPort}/speech/v1/audio/transcriptions`,
      streamEndpoint: `ws://127.0.0.1:${asrPort}/speech/v1/listen`,
      model: 'stub',
      mode: 'streaming',
      streamProtocol: 'deepgram',
      allowPrivateNetwork: true,
    },
  },
});
const started = (await call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 })) as {
  streamId?: string;
};
const chunk = Buffer.alloc(3200).toString('base64');
for (let n = 0; n < 3; n++)
  await call('voice.stream.chunk', { streamId: started.streamId, audioBase64: chunk });
const stopped = await call('voice.stream.stop', { streamId: started.streamId });
console.log(JSON.stringify({ started, stopped, texts }, null, 1));
ws.close();
