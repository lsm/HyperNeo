import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [readyPath, evidence] = process.argv.slice(2);
assert(readyPath && evidence);
const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
assert.notEqual(String(ready.port), '8399');
mkdirSync(evidence, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const result = { desktop: null, passed: false };
try {
  const width = Number(process.env.VERIFY_WIDTH ?? 1280);
  const page = await (await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US' })).newPage();
  await page.goto(ready.url);
  if (width < 1120) await page.getByRole('button', { name: /^Your work/ }).click();
  const opener = page.locator('article,section,div').filter({ hasText: 'Follow Local worker' }).getByRole('button', { name: /^Open/ }).last();
  await opener.waitFor();
  await opener.click();
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].map((tab) => ({ id: tab.id, selected: tab.getAttribute('aria-selected') === 'true' })));
  const chatInColumn = await page.evaluate(() => !!document.querySelector('main [aria-label*="chat"]'));
  assert.deepEqual(tabs.map((tab) => tab.id), ['artifact-preview-work-tab', 'artifact-session-tab-local-worker']);
  assert.deepEqual(tabs.map((tab) => tab.selected), [false, true]);
  assert.equal(chatInColumn, false);
  await page.screenshot({ path: `${evidence}/session-tab-${width}.png` });
  result.desktop = { width, tabs, chatInColumn, screenshot: `${evidence}/session-tab-${width}.png` };
  result.passed = true;
} finally {
  await browser.close();
  writeFileSync(`${evidence}/session-tab.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
