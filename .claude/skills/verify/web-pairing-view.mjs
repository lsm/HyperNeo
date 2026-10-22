import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, mode] = process.argv.slice(2);
assert(port && run && mode && port !== '8399', 'usage: web-pairing-view.mjs <port> <run-dir> paired|awaiting');
const code = process.env.PAIR_CODE;
assert(code, 'PAIR_CODE is required');
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const width = mode === 'paired' ? 1280 : 390;
const browser = await chromium.launch({ headless: true });
const shot = (page, name, mask = []) =>
  page.screenshot({ path: `${run}/evidence/${name}-${width}.png`, mask });
try {
  const context = await browser.newContext({ viewport: { width, height: mode === 'paired' ? 800 : 760 } });
  const page = await context.newPage();
  const pair = page.getByRole('button', { name: 'Pair this browser' });
  await page.goto(`${base}/pair#ZZZZZZZZZZ`);
  await pair.waitFor({ timeout: 30000 });
  await shot(page, 'form');
  await pair.click();
  const wrong = await page.getByText('That code is wrong or expired.', { exact: false }).innerText();
  await shot(page, 'wrong-code');
  await page.goto(`${base}/pair#${code}`);
  await page.getByLabel('Name for this browser').fill(`Browser ${width}`);
  await pair.click();
  const result = {};
  if (mode === 'paired') {
    await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
    result.urlAfterPairing = page.url();
    await shot(page, 'paired');
    result.cookies = (await context.cookies()).map(({ name, httpOnly, sameSite, secure, path, value }) => ({
      name,
      httpOnly,
      sameSite,
      secure,
      path,
      valueLength: value.length,
    }));
    result.bodyHasCredential = await page.evaluate(() => document.cookie.includes('hyperneo_device'));
    await page.getByRole('link', { name: 'Open HyperNeo' }).click();
    await page.waitForTimeout(4000);
    result.appUrl = page.url();
  } else {
    result.awaiting = await page.getByText('Waiting for Allow on a paired phone or browser.', { exact: false }).innerText();
    await shot(page, 'awaiting', [page.getByLabel('Pairing code')]);
  }
  writeFileSync(`${run}/evidence/web-pairing-${mode}.json`, JSON.stringify({ wrong, ...result }, null, 2));
  console.log(JSON.stringify({ mode, width, wrong, ...result }));
} finally {
  await browser.close();
}
