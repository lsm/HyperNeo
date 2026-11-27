import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const run = process.argv[2];
const replyDelayMs = 800;
const fixture = JSON.parse(readFileSync(`${run}/browser.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const launched = chromium.launch({
  executablePath: process.env.VERIFY_BROWSER,
  handleSIGTERM: false,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${run}/tone.wav`,
  ],
});
const result = { replyDelayMs };

async function finish() {
  try {
    writeFileSync(`${run}/evidence/chunk-pipeline.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await (await launched).close();
  }
}

process.once('SIGTERM', () => {
  void finish().finally(() => process.exit(143));
});

try {
  const browser = await launched;
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${fixture.base}/pair`, {
    headers: { origin: fixture.base },
    data: { code: fixture.code, name: 'Synthetic voice browser' },
  });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1280, height: 1000 },
    permissions: ['microphone'],
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      const output = audio.createMediaStreamDestination();
      gain.gain.value = 0.3;
      tone.connect(gain).connect(output);
      tone.start();
      return output.stream;
    };
  });
  await context.addInitScript((delay) => {
    const chunks = { sent: [], inFlight: 0, maxInFlight: 0 };
    window.chunkPipeline = chunks;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        const pending = new Set();
        const send = this.send.bind(this);
        this.send = (payload) => {
          const message = typeof payload === 'string' ? JSON.parse(payload) : null;
          if (message?.type === 'REQ' && message.method === 'voice.stream.chunk') {
            pending.add(message.id);
            chunks.inFlight++;
            chunks.maxInFlight = Math.max(chunks.maxInFlight, chunks.inFlight);
            chunks.sent.push({
              capturedAt: message.data.capturedAt,
              sentAt: message.data.sentAt,
            });
          }
          send(payload);
        };
        const later = (handler) => (event) =>
          setTimeout(() => {
            const message = typeof event.data === 'string' ? JSON.parse(event.data) : null;
            if (message?.type === 'RSP' && pending.delete(message.requestId)) chunks.inFlight--;
            handler.call(this, event);
          }, delay);
        const listen = this.addEventListener.bind(this);
        this.addEventListener = (type, handler, options) =>
          listen(type, type === 'message' ? later(handler) : handler, options);
        let onmessage = null;
        Object.defineProperty(this, 'onmessage', {
          get: () => onmessage,
          set: (handler) => {
            if (onmessage) super.removeEventListener?.('message', onmessage.wrapped);
            onmessage = handler;
            if (handler) {
              handler.wrapped = later(handler);
              listen('message', handler.wrapped);
            }
          },
        });
      }
    };
  }, replyDelayMs);
  const page = await context.newPage();
  const call = async (path, data) => {
    const reply = await page.request.fetch(
      `${fixture.asr}/${path}`,
      data ? { method: 'POST', data } : {}
    );
    assert(reply.ok());
    return reply.json();
  };
  try {
    await call('mode', { streaming: true });
    await page.goto(`${fixture.base}/neo`);
    const form = page.locator('form.neo-composer-input');
    const start = form.getByRole('button', { name: 'Start voice input', exact: true });
    const stop = form.getByRole('button', {
      name: 'Stop recording and keep the text as a draft',
      exact: true,
    });
    const draft = form.locator('textarea');
    await call('arm', { id: 'pipeline', text: 'Spoken over a slow link' });
    await start.click();
    await form.getByTestId('voice-bars').waitFor();
    await page.waitForTimeout(4_000);
    await page.screenshot({ path: `${run}/evidence/chunk-pipeline-recording.png` });
    await stop.click();
    const deadline = Date.now() + 20_000;
    do {
      result.asr = await call('stats');
      if (result.asr.held) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert(result.asr.held, 'Stopping must close the live stream');
    assert.equal(result.asr.route, 'streaming');
    await call('release');
    await page.waitForFunction(() =>
      document
        .querySelector('form.neo-composer-input textarea')
        ?.value.includes('Spoken over a slow link')
    );
    result.draft = await draft.inputValue();
    Object.assign(result, await page.evaluate(() => window.chunkPipeline));
    assert(result.sent.length >= 3, 'Four seconds of audio must produce several chunks');
    assert(
      result.maxInFlight >= 2,
      'Chunks must not wait for the previous reply over a slow link'
    );
    for (const chunk of result.sent) {
      assert(Number.isFinite(chunk.capturedAt) && Number.isFinite(chunk.sentAt));
      assert(chunk.sentAt >= chunk.capturedAt);
    }
    result.passed = true;
  } catch (error) {
    result.error = String(error);
    Object.assign(result, await page.evaluate(() => window.chunkPipeline).catch(() => ({})));
    await page.screenshot({ path: `${run}/evidence/chunk-pipeline-failure.png` });
    throw error;
  } finally {
    await context.close();
  }
} finally {
  await finish();
}
