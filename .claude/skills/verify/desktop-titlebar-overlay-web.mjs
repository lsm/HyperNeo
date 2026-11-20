import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, code] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const results = [];
try {
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, { headers: { origin: base }, data: { code, name: 'Synthetic desktop proof' } });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ storageState, viewport: { width: 700, height: 900 }, colorScheme: theme, locale: 'en-US', reducedMotion: 'reduce' });
    try {
      await context.addInitScript(theme => { window.isTauri = true; localStorage.setItem('theme', theme); }, theme);
      const page = await context.newPage();
      await page.goto(`${base}/neo`);
      await page.getByRole('button', { name: /^Your work/ }).click();
      await page.locator('[data-question-source]').getByRole('button', { name: 'Open session: Synthetic worker', exact: true }).click();
      const back = page.getByRole('button', { name: 'Back to Neo', exact: true });
      await back.waitFor();
      await page.getByRole('textbox', { name: 'Message this chat', exact: true }).waitFor();
      const geometry = await back.evaluate(el => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { top: box.top, hit: hit === el || el.contains(hit) };
      });
      await page.evaluate(() => {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:16px;top:28px;display:flex;gap:7px;z-index:2147483647;pointer-events:none';
        for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
          const light = document.createElement('span');
          light.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};border:1px solid #0003`;
          box.append(light);
        }
        document.documentElement.append(box);
      });
      await page.screenshot({ path: `${run}/evidence/titlebar-session-${theme}.png` });
      results.push({ theme, ...geometry });
      assert(geometry.top >= 52 && geometry.hit, `Back button covered: ${JSON.stringify(geometry)}`);
      await back.click({ timeout: 3000 });
      assert.equal(await page.locator('.neo-session-pane').count(), 0);
      await page.getByRole('button', { name: 'Close work list', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Settings', exact: true });
      await drawer.waitFor();
      await page.screenshot({ path: `${run}/evidence/titlebar-drawer-${theme}.png` });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  writeFileSync(`${run}/evidence/titlebar-overlay.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
