import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const run = process.argv[2];
const fixture = JSON.parse(readFileSync(`${run}/browser.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  executablePath: process.env.VERIFY_BROWSER,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${run}/tone.wav`,
  ],
});
const results = {};
try {
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${fixture.base}/pair`, {
    headers: { origin: fixture.base },
    data: { code: fixture.code, name: 'Synthetic voice browser' },
  });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();

  for (const hasTouch of [false, true]) {
    const name = hasTouch ? 'touch' : 'desktop';
    const result = (results[name] = {});
    const context = await browser.newContext({
      storageState,
      hasTouch,
      isMobile: hasTouch,
      viewport: hasTouch ? { width: 390, height: 844 } : { width: 1280, height: 1000 },
      permissions: ['microphone'],
      locale: 'en-US',
    });
    await context.addInitScript(() => {
      const connect = MediaStreamAudioSourceNode.prototype.connect;
      MediaStreamAudioSourceNode.prototype.connect = function (...args) {
        window.releaseCapture = () => {
          connect.apply(this, args);
          return performance.now();
        };
        return args[0];
      };
    });
    const page = await context.newPage();
    const call = async (path, data) => {
      const reply = await page.request.fetch(
        `${fixture.asr}/${path}`,
        data ? { method: 'POST', data } : {}
      );
      assert(reply.ok());
      return reply.json();
    };
    const press = (button) => (hasTouch ? button.tap() : button.click());
    try {
      await page.goto(`${fixture.base}/neo`);
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), hasTouch);
      const form = page.locator('form.neo-composer-input');
      const start = form.getByRole('button', { name: 'Start voice input', exact: true });
      const cancel = form.getByRole('button', { name: 'Cancel microphone startup', exact: true });
      const stop = form.getByRole('button', {
        name: 'Stop recording and keep the text as a draft',
        exact: true,
      });
      const bars = form.getByTestId('voice-bars');
      const draft = form.locator('textarea');
      await draft.fill('Typed first');
      await call('arm', { id: name, text: 'Spoken after startup' });
      await press(start);
      await page.waitForFunction(() => typeof window.releaseCapture === 'function');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${run}/evidence/${name}-starting.png` });
      assert.equal(await bars.count(), 0, 'Waveform must stay hidden without microphone samples');
      assert.equal(await stop.count(), 0);
      assert.equal(await cancel.getAttribute('aria-busy'), 'true');
      await press(cancel);
      await start.waitFor();
      assert.equal((await call('stats')).received, 0);
      assert.equal(await draft.inputValue(), 'Typed first');
      await page.evaluate(() => {
        delete window.releaseCapture;
      });

      await press(start);
      await page.waitForFunction(() => typeof window.releaseCapture === 'function');
      const releasedAt = await page.evaluate(() => window.releaseCapture());
      await bars.waitFor();
      result.delayMs = await page.evaluate((start) => performance.now() - start, releasedAt);
      assert(result.delayMs >= 200, 'Waveform must give the microphone time to stabilize');
      await press(stop);
      const deadline = Date.now() + 12_000;
      do {
        result.asr = await call('stats');
        if (result.asr.held) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      assert(result.asr.held, 'Stopping must submit captured audio for transcription');
      assert(result.asr.bytes >= 8_044, 'The WAV must include audio captured during startup');
      await call('release');
      await page.waitForFunction(
        () =>
          document.querySelector('form.neo-composer-input textarea')?.value ===
          'Typed first\nSpoken after startup'
      );
      result.draft = await draft.inputValue();
      result.sends = (await call('observed')).receipts.length;
      assert.equal(result.sends, 0);
    } catch (error) {
      result.error = String(error);
      await page.screenshot({ path: `${run}/evidence/${name}-failure.png` });
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  writeFileSync(`${run}/evidence/capture-readiness.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  await browser.close();
}
