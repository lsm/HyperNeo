import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: neo-worker-permission-view.mjs <port> <run-dir>');
const db = `${run}/data/daemon.db`;
const sql = (statement) => execFileSync('sqlite3', ['-cmd', '.timeout 10000', db, statement], { encoding: 'utf8' }).trim();
const neo = () => JSON.parse(sql("SELECT json_extract(settings, '$.neo') FROM global_settings WHERE id = 1"));
const others = { standingRules: ['Keep PRs small'], packs: ['coding'], mutedSessions: ['codex::quiet'], autoDispatch: true };
const seed = (mode) =>
  sql(`UPDATE global_settings SET settings = json_set(settings, '$.neo', json('${JSON.stringify({ ...others, ...(mode ? { workerPermissionMode: mode } : {}) })}')) WHERE id = 1`);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const result = { cases: [] };
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const select = page.getByRole('combobox', { name: 'Claude worker permission' });
  const open = async () => {
    await page.goto(`http://127.0.0.1:${port}/settings?tab=neo-model`);
    await select.waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
  };
  for (const mode of [undefined, 'bypassPermissions', 'auto', 'acceptEdits', 'default']) {
    seed(mode);
    const before = sql('SELECT settings, updated_at FROM global_settings WHERE id = 1');
    await open();
    const shown = await select.evaluate((element) => ({
      value: element.value,
      label: element.options[element.selectedIndex].textContent,
    }));
    const unchangedByOpen = before === sql('SELECT settings, updated_at FROM global_settings WHERE id = 1');
    result.cases.push({ saved: mode ?? 'unset', ...shown, unchangedByOpen });
  }
  seed(undefined);
  await open();
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${run}/evidence/worker-permission-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await select.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${run}/evidence/worker-permission-390.png` });
  result.scope = await page.getByText('Claude Code workers Neo starts from now on').innerText();
  await select.selectOption('acceptEdits');
  await page.waitForTimeout(1500);
  result.afterPick = neo();
  assert.equal(result.afterPick.workerPermissionMode, 'acceptEdits');
  assert.deepEqual({ ...result.afterPick, workerPermissionMode: undefined }, { ...others, workerPermissionMode: undefined });
  result.shownAfterPick = await select.inputValue();
  writeFileSync(`${run}/evidence/neo-worker-permission.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
