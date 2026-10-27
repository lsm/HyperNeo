import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { WebSocketServer } = createRequire(new URL('../../../packages/daemon/package.json', import.meta.url))('ws');
const [run, port, asrPort] = process.argv.slice(2);
assert(port && run && asrPort && port !== '8399' && asrPort !== '8399');
const connections = [];
const asr = new WebSocketServer({ host: '127.0.0.1', port: Number(asrPort) });
asr.on('connection', (socket, request) => {
  connections.push(new URL(request.url, 'http://stub').searchParams.get('language'));
  socket.on('message', (data, binary) => {
    if (!binary && JSON.parse(data.toString()).type === 'CloseStream') {
      socket.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Language proof' }] } }));
      socket.close(1000);
    }
  });
});
function rpc(name, data) {
  const reply = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', `rpc:${name}`, JSON.stringify(data)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!reply.error, JSON.stringify(reply));
  return reply;
}
let browser;
try {
  rpc('settings.global.update', { updates: { voice: {
    enabled: true, endpoint: `http://127.0.0.1:${asrPort}/v1/audio/transcriptions`,
    model: 'stub', mode: 'streaming', streamEndpoint: `ws://127.0.0.1:${asrPort}/v1/listen`,
    streamProtocol: 'deepgram', allowPrivateNetwork: true,
  } } });
  if (process.env.VERIFY_RPC_ONLY === '1') {
    const observations = [];
    const socket = new (createRequire(new URL('../../../packages/daemon/package.json', import.meta.url))('ws'))(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const call = (method, data) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
      const receive = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.requestId !== id && message.id !== id) return;
        clearTimeout(timer);
        socket.off('message', receive);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.data);
      };
      socket.on('message', receive);
      socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    try {
      for (const language of [undefined, 'zh', 'en', undefined]) {
        const request = { encoding: 'pcm16', sampleRate: 16000, ...(language ? { language } : {}) };
        const started = await call('voice.stream.start', request);
        assert.equal(started.via, 'streaming');
        assert.equal(connections.at(-1), language ?? null);
        await call('voice.stream.chunk', { streamId: started.streamId, audioBase64: Buffer.alloc(3200).toString('base64') });
        const stopped = await call('voice.stream.stop', { streamId: started.streamId });
        assert.equal(stopped.text, 'Language proof');
        observations.push({ request, asrLanguage: connections.at(-1), stopped });
      }
    } finally { socket.close(); }
    writeFileSync(`${run}/evidence/voice-language-rpc.json`, JSON.stringify({ observations, connections }, null, 2));
    console.log(JSON.stringify({ observations, connections }, null, 2));
  } else {
  browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const requests = [];
  page.on('websocket', (socket) => socket.on('framesent', ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.method === 'voice.stream.start') requests.push(message.data);
    } catch {}
  }));
  await page.goto(`http://127.0.0.1:${port}/settings?tab=voice`);
  const select = page.getByRole('combobox', { name: 'Live transcription language' });
  assert.equal(await select.inputValue(), 'auto');
  const observations = [];
  for (const language of ['auto', 'zh', 'en', 'auto']) {
    await select.selectOption(language);
    await page.reload();
    assert.equal(await select.inputValue(), language);
    await page.screenshot({ path: `${run}/evidence/voice-language-${language}.png`, fullPage: true });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
    await page.getByRole('button', { name: 'Stop recording and keep the text as a draft' }).waitFor();
    for (let attempt = 0; connections.length <= observations.length && attempt < 100; attempt++) await page.waitForTimeout(50);
    assert.equal(connections.at(-1), language === 'auto' ? null : language);
    const request = requests.at(-1);
    assert(request);
    if (language === 'auto') assert(!Object.hasOwn(request, 'language'));
    else assert.equal(request.language, language);
    observations.push({ language, request, asrLanguage: connections.at(-1) });
    await page.getByRole('button', { name: 'Stop recording and keep the text as a draft' }).click();
    await page.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
    await page.goto(`http://127.0.0.1:${port}/settings?tab=voice`);
  }
  writeFileSync(`${run}/evidence/voice-language.json`, JSON.stringify({ observations, connections }, null, 2));
  console.log(JSON.stringify({ observations, connections }, null, 2));
  }
} finally {
  await browser?.close();
  for (const socket of asr.clients) socket.terminate();
  await new Promise((resolve) => asr.close(resolve));
}
