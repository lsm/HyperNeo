import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, code] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const results = [];
try {
  for (const theme of ['light']) {
    const context = await browser.newContext({ viewport: { width: 700, height: 900 }, colorScheme: theme, locale: 'en-US', reducedMotion: 'reduce' });
    try {
      await context.addInitScript(theme => { window.isTauri = true; localStorage.setItem('theme', theme); }, theme);
      const response = await context.request.post(`${base}/pair`, { headers: { origin: base }, data: { code, name: 'Synthetic desktop proof' } });
      assert.equal(response.status(), 200);
      const page = await context.newPage();
      await page.goto(`${base}/neo`);
      await page.getByRole('button', { name: /^Your work/ }).click();
      await page.locator('[data-question-source]').getByRole('button', { name: 'Open session: Synthetic worker', exact: true }).click();
      const back = page.getByRole('button', { name: 'Back to Neo', exact: true });
      await back.waitFor();
      const geometry = await back.evaluate(el => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { top: box.top, hit: hit === el || el.contains(hit) };
      });
      await page.screenshot({ path: `${run}/evidence/titlebar-session-${theme}.png` });
      results.push({ theme, ...geometry });
      assert(geometry.top >= 52 && geometry.hit, `Back button covered: ${JSON.stringify(geometry)}`);
      await back.click({ timeout: 3000 });
      assert.equal(await page.locator('.neo-session-pane').count(), 0);
      await page.getByRole('button', { name: 'Settings and connection', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Settings and connection' });
      await drawer.waitFor();
      await page.screenshot({ path: `${run}/evidence/titlebar-drawer-${theme}.png` });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  writeFileSync(`${run}/evidence/titlebar-overlay.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
