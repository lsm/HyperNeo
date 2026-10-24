import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: sdk-permission-settings-view.mjs <port> <run-dir>');
const db = `${run}/data/daemon.db`;
const sql = (statement) => execFileSync('sqlite3', [db, statement], { encoding: 'utf8' }).trim();
const row = () => sql('SELECT settings, updated_at FROM global_settings WHERE id = 1');
const saved = () => sql("SELECT json_extract(settings, '$.permissionMode') FROM global_settings WHERE id = 1");
const seed = (mode) =>
  sql(
    mode === undefined
      ? "UPDATE global_settings SET settings = json_remove(settings, '$.permissionMode') WHERE id = 1"
      : `UPDATE global_settings SET settings = json_set(settings, '$.permissionMode', '${mode}') WHERE id = 1`
  );
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const result = { cases: [] };
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const select = page.locator('select').filter({ has: page.locator('option[value="acceptEdits"]') });
  const open = async () => {
    await page.goto(`http://127.0.0.1:${port}/settings?tab=general`);
    await select.waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
  };
  for (const mode of [undefined, 'default', 'bypassPermissions', 'acceptEdits', 'plan', 'delegate']) {
    seed(mode);
    const before = row();
    await open();
    const shown = await select.evaluate((element) => ({
      value: element.value,
      label: element.options[element.selectedIndex].textContent,
      options: [...element.options].map((option) => option.textContent),
    }));
    const after = row();
    result.cases.push({ saved: mode ?? 'unset', ...shown, unchangedByOpen: before === after });
    await page.screenshot({ path: `${run}/evidence/permission-${mode ?? 'unset'}.png` });
  }
  result.description = await page.getByText('Default or unset runs new HyperNeo SDK sessions').innerText();
  const language = page.locator('select').filter({ has: page.locator('option[value="zh-Hans"]') });
  await language.selectOption('en');
  await page.waitForTimeout(1000);
  result.afterUnrelatedSave = {
    permissionMode: saved(),
    language: sql("SELECT json_extract(settings, '$.language') FROM global_settings WHERE id = 1"),
  };
  await language.selectOption('system');
  await page.waitForTimeout(500);
  await select.selectOption('plan');
  await page.waitForTimeout(1000);
  result.afterPickingPlan = saved();
  writeFileSync(`${run}/evidence/sdk-permission-settings.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
