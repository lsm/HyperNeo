import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const [port, evidence] = process.argv.slice(2);
assert(port && port !== '8399' && evidence && process.env.PAIR_CODE);
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
try {
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, {
    headers: { origin: base }, data: { code: process.env.PAIR_CODE, name: 'Synthetic browser' },
  });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  for (const width of [1280, 390]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, storageState, colorScheme: theme });
      await context.addInitScript((value) => localStorage.setItem('theme', value), theme);
      const page = await context.newPage();
      await page.goto(`${base}/settings?tab=voice`);
      await page.getByLabel('API key for api.openai.com', { exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.getByLabel('API key for api.openai.com', { exact: true }).count(), 1);
      assert.equal(await page.getByLabel('API key for api.deepgram.com', { exact: true }).count(), 1);
      assert.equal(await page.getByLabel('API key for api.openai.com', { exact: true }).getAttribute('type'), 'password');
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      if (width === 390) await page.getByLabel('API key for api.deepgram.com', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/voice-host-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
      await context.close();
    }
  }
  assert(process.env.HYPERNEO_DATA_DIR?.startsWith(process.env.RUN + '/'));
  const database = new DatabaseSync(`${process.env.HYPERNEO_DATA_DIR}/daemon.db`, { readOnly: true });
  const count = () => database.prepare('SELECT count(*) AS count FROM provider_credentials WHERE provider_id = ?')
    .get('neokai.provider.voice-transcription:api.deepgram.com:default').count;
  async function expectCount(expected) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (count() === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(count(), expected);
  }
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const sent = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => sent.push(String(frame.payload))));
  await page.goto(`${base}/settings?tab=voice`);
  const key = page.getByLabel('API key for api.deepgram.com', { exact: true });
  await key.fill('synthetic-browser-key');
  await key.blur();
  await page.waitForFunction(() => {
    const field = document.querySelector('[aria-label="API key for api.deepgram.com"]');
    return field && field.value === '';
  });
  await expectCount(1);
  await page.getByText('Key saved for api.deepgram.com').waitFor();
  await page.reload();
  await page.getByLabel('API key for api.deepgram.com', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByLabel('API key for api.deepgram.com', { exact: true }).inputValue(), '');
  const remove = page.getByLabel('Remove API key for api.deepgram.com');
  await key.fill('synthetic-unsaved-pointer');
  await remove.click();
  await expectCount(0);
  await page.getByText('No host-specific key saved for api.deepgram.com').waitFor();
  assert(!sent.some((frame) => frame.includes('synthetic-unsaved-pointer')));
  assert.equal(await key.inputValue(), '');
  await key.fill('synthetic-unsaved-keyboard');
  await key.press('Tab');
  await remove.press('Enter');
  await expectCount(0);
  assert(!sent.some((frame) => frame.includes('synthetic-unsaved-keyboard')));
  assert.equal(await key.inputValue(), '');
  database.close();
  await context.close();
  console.log(JSON.stringify({ screenshots: 4, uniqueHostFields: 2, passwordInputs: true, savedAndRemoved: true, feedbackShown: true, discardedWithoutSave: true }));
} finally {
  await browser.close();
}
