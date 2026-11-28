import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run, label] = process.argv.slice(2);
assert(port && run && label && !['8399', '8499'].includes(port));
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const made = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', '{"kind":"human"}'], { encoding: 'utf8' })).reply;
  const pairing = await browser.newContext();
  assert.equal((await pairing.request.post(`${base}/pair`, { headers: { origin: base }, data: { code: made.code, name: 'Synthetic pace browser' } })).status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, permissions: ['microphone'],
    reducedMotion: process.env.VERIFY_REDUCED_MOTION === '1' ? 'reduce' : 'no-preference',
    recordVideo: { dir: `${run}/evidence/video-${label}`, size: { width: 1280, height: 800 } } });
  if (process.env.VERIFY_SYNTHETIC_MIC === '1')
    await context.addInitScript(() => {
      delete window.AudioEncoder;
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext();
        const tone = audio.createOscillator();
        const out = audio.createMediaStreamDestination();
        tone.connect(out);
        tone.start();
        return out.stream;
      };
    });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => console.error(String(error)));
  await page.goto(`${base}/neo`);
  const form = page.locator('form.neo-composer-input');
  await page.getByRole('textbox', { name: 'Message Neo', exact: true }).click();
  await form.getByRole('button', { name: 'Start voice input', exact: true }).click();
  await form.getByRole('button', { name: 'Cancel recording', exact: true }).focus();
  await form.getByTestId('voice-interim-text').waitFor().catch(async (error) => {
    await page.screenshot({ path: `${run}/evidence/${label}-no-interim.png` });
    throw error;
  });
  const sampling = page.evaluate(() => new Promise(resolve => {
    const out = []; const start = performance.now();
    const tick = () => {
      const t = Math.round(performance.now() - start);
      out.push([t, document.querySelector('[data-testid=voice-interim-text]')?.textContent?.length ?? 0]);
      if (t < 6000) requestAnimationFrame(tick); else resolve(out);
    };
    tick();
  }));
  const fade = await page.evaluate(() => {
    const fresh = document.querySelector('[data-testid=voice-interim-fresh]');
    return fresh ? getComputedStyle(fresh).animationName : null;
  });
  const strip = [];
  for (let shot = 0; shot < 8; shot++) {
    strip.push((await form.screenshot()).toString('base64'));
    await page.waitForTimeout(250);
  }
  const samples = await sampling;
  const sheet = await context.newPage();
  await sheet.setContent(`<body style="margin:0;background:#fff">${strip.map((png, i) => `<div style="font:12px sans-serif;padding:4px">${label}, shot ${i + 1} (about 250 ms apart)</div><img src="data:image/png;base64,${png}" style="display:block;width:720px">`).join('')}</body>`);
  await sheet.screenshot({ path: `${run}/evidence/${label}-strip.png`, fullPage: true });
  await sheet.close();
  await form.getByRole('button', { name: 'Cancel recording', exact: true }).click();
  const video = page.video();
  await context.close();
  renameSync(await video.path(), `${run}/evidence/${label}.webm`);
  const jumps = samples.slice(1).map(([, n], i) => n - samples[i][1]).filter(d => d > 0);
  const sorted = [...jumps].sort((a, b) => a - b);
  const summary = { label, frames: samples.length, changes: jumps.length, largestJump: sorted.at(-1), medianJump: sorted[sorted.length >> 1], finalLength: samples.at(-1)[1], fade };
  writeFileSync(`${run}/evidence/${label}.json`, JSON.stringify({ summary, samples }));
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
}
