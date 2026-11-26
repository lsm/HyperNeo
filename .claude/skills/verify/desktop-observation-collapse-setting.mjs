import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: desktop-observation-collapse-setting.mjs <port> <run-dir>');
const stored = () =>
  execFileSync('sqlite3', ['-cmd', '.timeout 10000', `${run}/data/daemon.db`,
    "SELECT coalesce(json_extract(settings, '$.desktopObservationCollapse'), 'unset') FROM global_settings WHERE id = 1"],
  { encoding: 'utf8' }).trim();
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const result = {};
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const toggle = page.getByRole('switch', { name: 'Collapse older desktop observations' });
  const open = async () => {
    await page.goto(`http://127.0.0.1:${port}/settings?tab=harness`);
    await toggle.waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
  };
  await open();
  result.storedBefore = stored();
  result.shownBefore = await toggle.getAttribute('aria-checked');
  assert.equal(result.storedBefore, 'unset');
  assert.equal(result.shownBefore, 'false');
  await toggle.click();
  await page.waitForTimeout(1500);
  result.storedAfterOn = stored();
  assert.equal(result.storedAfterOn, '1');
  await open();
  result.shownAfterReload = await toggle.getAttribute('aria-checked');
  assert.equal(result.shownAfterReload, 'true');
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${run}/evidence/collapse-setting-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${run}/evidence/collapse-setting-390.png` });
  await toggle.click();
  await page.waitForTimeout(1500);
  result.storedAfterOff = stored();
  assert.equal(result.storedAfterOff, '0');
  writeFileSync(`${run}/evidence/collapse-setting.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
