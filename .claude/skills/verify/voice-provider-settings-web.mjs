import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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
      await page.getByLabel('Speech provider').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.getByLabel('Live model').count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      await page.screenshot({ path: `${evidence}/voice-provider-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
      await page.getByLabel('Speech voice').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/voice-speech-${theme}-${width}.png`, fullPage: true, animations: 'disabled' });
      await context.close();
    }
  }
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto(`${base}/settings?tab=voice`);
  await page.getByLabel('Speech provider').waitFor({ timeout: 30000 });
  for (const [label, value] of [['Recorded provider', 'deepgram'], ['Live provider', 'openai-realtime'], ['Speech provider', 'deepgram']]) {
    await page.getByLabel(label).selectOption(value);
    await page.getByLabel(label).waitFor({ state: 'visible' });
    await page.waitForFunction(([name, expected]) => {
      const e = document.querySelector(`[aria-label="${name}"]`);
      return e && !e.disabled && e.value === expected;
    }, [label, value]);
  }
  for (const [label, value] of [['Speech endpoint', 'https://speech.example.test/v1/speak'], ['Speech model', 'synthetic-model'], ['Speech voice', 'synthetic-voice']]) {
    await page.getByLabel(label).fill(value);
    await page.getByLabel(label).blur();
    await page.waitForTimeout(200);
  }
  await page.reload();
  await page.getByLabel('Speech provider').waitFor({ timeout: 30000 });
  for (const [label, value] of [['Recorded provider', 'deepgram'], ['Live provider', 'openai-realtime'], ['Speech provider', 'deepgram'], ['Speech endpoint', 'https://speech.example.test/v1/speak'], ['Speech model', 'synthetic-model'], ['Speech voice', 'synthetic-voice']]) {
    await page.waitForFunction(([name, expected]) => document.querySelector(`[aria-label="${name}"]`)?.value === expected, [label, value]);
  }
  await context.close();
  console.log(JSON.stringify({ screenshots: 8, providersPersist: true, speechFieldsPersist: true, liveModelAbsent: true }));
} finally {
  await browser.close();
}
