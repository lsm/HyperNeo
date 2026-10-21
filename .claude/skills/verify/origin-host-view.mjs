import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: origin-host-view.mjs <port> <run-dir>');
const code = process.env.PAIR_CODE;
assert(code, 'PAIR_CODE is required');
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  await page.goto(`${base}/settings?tab=devices`);
  const refused = page.getByText('Host not allowed', { exact: false }).first();
  await refused.waitFor({ timeout: 30000 });
  await page.getByLabel('Allowed host').fill('mac.tailnet.example');
  await page.getByRole('button', { name: 'Add host' }).click();
  await page.getByRole('button', { name: 'Remove mac.tailnet.example' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/origin-host-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/origin-host-390.png`, fullPage: true });
  const rows = await page.locator('text=/not allowed ·/').allInnerTexts();
  writeFileSync(`${run}/evidence/origin-host-view.json`, JSON.stringify({ rows }, null, 2));
  console.log(JSON.stringify({ hostAddedInUi: true, rows }));
} finally {
  await browser.close();
}
