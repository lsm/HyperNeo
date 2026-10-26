import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv[2]);
const { url } = JSON.parse(readFileSync(join(run, 'evidence/web.json'), 'utf8'));
const target = new URL(url);
assert.equal(target.hostname, '127.0.0.1');
assert.notEqual(target.port, '8399');
const { chromium } = await import(process.env.VERIFY_PLAYWRIGHT_MODULE || 'playwright');
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_CHROMIUM ? { executablePath: process.env.VERIFY_CHROMIUM } : {}) });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'en-US' });
  await context.route('**/*', (route) => new URL(route.request().url()).origin === target.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(url);
  await page.getByText('Human small: keep these exact words inline.', { exact: false }).waitFor();
  await page.getByText('Human large: keep these exact words inline.', { exact: false }).waitFor();
  await page.waitForTimeout(1000);
  const workerRows = page.locator('[data-public-entry]').filter({ hasText: 'System-forwarded worker messages' });
  assert.equal(await workerRows.count(), 0);
  const text = await page.locator('body').innerText();
  assert(!text.includes('worker note 00'));
  await page.screenshot({ path: join(run, 'evidence/headless-expanded.png'), fullPage: true });
  writeFileSync(join(run, 'evidence/headless-page.txt'), text);
  await page.reload();
  await page.getByText('Human small: keep these exact words inline.', { exact: false }).waitFor();
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('[data-public-entry]').filter({ hasText: 'System-forwarded worker messages' }).count(), 0);
  await page.screenshot({ path: join(run, 'evidence/headless-reloaded.png'), fullPage: true });
  writeFileSync(join(run, 'evidence/headless.json'), JSON.stringify({ headless: true, batchRows: 0, humanVisible: true, survivesReload: true }));
  console.log('PASS headless worker batch hidden');
} catch (error) {
  writeFileSync(join(run, 'evidence/headless-unverified.json'), JSON.stringify({ browser: 'unverified', error: String(error) }));
  throw error;
} finally {
  await browser?.close();
  writeFileSync(join(run, 'finish-ui'), 'finished');
}
