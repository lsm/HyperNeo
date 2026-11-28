import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run, label] = process.argv.slice(2);
assert(port && run && label && !['8399', '8499'].includes(port));
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
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
  const { samples, fade } = await page.evaluate(() => new Promise(resolve => {
    const out = []; let fade = []; const start = performance.now();
    const tick = () => {
      const t = Math.round(performance.now() - start);
      const all = document.querySelector('[data-testid=voice-interim-text]')?.textContent?.length ?? 0;
      const clear = document.querySelector('[data-testid=voice-interim-pending]')?.textContent?.length ?? 0;
      out.push([t, all - clear, all]);
      const fresh = [...document.querySelectorAll('[data-testid=voice-interim-fresh]')];
      if (fresh.length > fade.length) fade = fresh.map(char => Number(getComputedStyle(char).opacity).toFixed(2));
      if (t < 6000) requestAnimationFrame(tick); else resolve({ samples: out, fade });
    };
    tick();
  }));
  const strip = [];
  for (let shot = 0; shot < 8; shot++) {
    strip.push((await form.screenshot()).toString('base64'));
    await page.waitForTimeout(250);
  }
  const sheet = await context.newPage();
  await sheet.setContent(`<body style="margin:0;background:#fff">${strip.map((png, i) => `<div style="font:12px sans-serif;padding:4px">${label}, shot ${i + 1} (about 250 ms apart)</div><img src="data:image/png;base64,${png}" style="display:block;width:720px">`).join('')}</body>`);
  await sheet.screenshot({ path: `${run}/evidence/${label}-strip.png`, fullPage: true });
  await sheet.close();
  await form.getByRole('button', { name: 'Cancel recording', exact: true }).click();
  const video = page.video();
  await context.close();
  renameSync(await video.path(), `${run}/evidence/${label}.webm`);
  const steps = samples.slice(1).map(([, n], i) => n - samples[i][1]);
  const gaps = samples.slice(1).map(([t], i) => t - samples[i][0]);
  let still = 0, longestStopMs = 0;
  for (const [i, step] of steps.entries()) {
    const [, shown, all] = samples[i + 1];
    still = step === 0 && shown < all ? still + gaps[i] : 0;
    longestStopMs = Math.max(longestStopMs, still);
  }
  const per60 = samples.map(([t, n]) => {
    const back = samples.findLast(([u]) => u <= t - 100);
    return back ? ((n - back[1]) * 1000) / 60 / (t - back[0]) : 0;
  });
  const summary = { label, frames: samples.length, medianFrameMs: [...gaps].sort((a, b) => a - b)[gaps.length >> 1],
    droppedFrames: gaps.filter(gap => gap > 25).length, maxCharsPerFrame: Math.max(...steps),
    framesOver1: steps.filter(d => d > 1).length, peakCharsPer60fpsFrame: Number(Math.max(...per60).toFixed(2)), longestStopMs,
    finalShown: samples.at(-1)[1], finalLaidOut: samples.at(-1)[2], fade };
  writeFileSync(`${run}/evidence/${label}.json`, JSON.stringify({ summary, samples }));
  console.log(JSON.stringify(summary));
} finally {
  await browser.close();
}
