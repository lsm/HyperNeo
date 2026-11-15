import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const run = process.argv[2];
const fixture = JSON.parse(readFileSync(`${run}/browser.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${run}/tone.wav`,
  ],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
  permissions: ['microphone'],
  locale: 'en-US',
});
await context.addInitScript(() => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await original(constraints);
    window.__voiceTracks = stream.getTracks();
    return stream;
  };
});
const page = await context.newPage();
const call = async (path, data) => {
  const response = await page.request.fetch(
    `${fixture.asr}/${path}`,
    data ? { method: 'POST', data } : {}
  );
  assert(response.ok());
  return response.json();
};
const wait = async (read, label) => {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(label);
};
const result = { phase: fixture.phase };
try {
  const paired = await context.request.post(`${fixture.base}/pair`, {
    headers: { origin: fixture.base },
    data: { code: fixture.code, name: 'Synthetic voice browser' },
  });
  assert.equal(paired.status(), 200);
  await page.goto(`${fixture.base}/neo`);
  const form = page.locator('form.neo-composer-input');
  await form.locator('textarea').waitFor();
  await form.locator('textarea').fill('Typed first');
  await call('arm', { id: 'track-ended', text: 'Spoken before the mic went away' });
  await form.getByRole('button', { name: 'Start voice input', exact: true }).click();
  const stop = form.getByRole('button', {
    name: 'Stop recording and keep the text as a draft',
    exact: true,
  });
  await stop.waitFor();
  const submit = form.locator('button[type=submit]');
  await wait(
    async () =>
      (await stop.isEnabled()) &&
      (await submit.getAttribute('aria-label')) === 'Stop recording and send the message',
    'Recorder must finish starting before the track ends'
  );
  await page.waitForTimeout(600);
  result.tracks = await page.evaluate(() => {
    for (const track of window.__voiceTracks) track.dispatchEvent(new Event('ended'));
    return window.__voiceTracks.length;
  });
  await page.screenshot({ path: `${run}/evidence/track-ended.png` });
  await wait(async () => (await call('stats')).held, 'The ended track must finish the clip');
  result.asr = await call('stats');
  await call('release');
  await form.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
  await wait(
    async () => (await form.locator('textarea').inputValue()).includes('Spoken before'),
    'The transcript must land in the draft'
  );
  result.draft = await form.locator('textarea').inputValue();
  result.sends = (await call('observed')).receipts.length;
  await page.screenshot({ path: `${run}/evidence/draft.png` });
  result.pass =
    result.tracks > 0 &&
    result.asr.received === 1 &&
    result.asr.bytes > 0 &&
    result.draft === 'Typed first\nSpoken before the mic went away' &&
    result.sends === 0;
  assert(result.pass, 'An ended mic track must leave its words in the draft without sending');
} catch (error) {
  result.error = String(error);
  await page.screenshot({ path: `${run}/evidence/failure.png` });
  throw error;
} finally {
  writeFileSync(`${run}/evidence/track-ended.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await browser.close();
}
