import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [base, evidence, phase, sessionId] = process.argv.slice(2);
assert(base && evidence && phase && sessionId);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const results = [];
mkdirSync(evidence, { recursive: true });
try {
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, { headers: { origin: base }, data: { code: process.env.PAIR_CODE, name: 'Synthetic desktop proof' } });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const routes = [['neo', '/neo'], ['sessions', '/sessions'], ['session', `/session/${sessionId}`], ['spaces', '/spaces'], ['settings', '/settings'], ['pair', '/pair']];
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ storageState, colorScheme: theme, viewport: { width: 1280, height: 900 } });
    await context.addInitScript((selectedTheme) => {
      window.isTauri = true;
      document.documentElement.classList.add('tauri-desktop');
      localStorage.setItem('theme', selectedTheme);
    }, theme);
    const page = await context.newPage();
    for (const [name, route] of routes) {
      await page.goto(`${base}${route}`);
      await page.locator('#root').waitFor({ state: 'attached' });
      await page.waitForTimeout(1500);
      const measurement = await page.evaluate(() => {
        const root = document.querySelector('.neo-shell, .desktop-window-shell, #root > *');
        const hit = document.elementFromPoint(400, 25);
        return { path: location.pathname, bodyText: document.body.innerText.slice(0, 100), top: root?.getBoundingClientRect().top, drag: hit?.hasAttribute('data-tauri-drag-region') ?? false };
      });
      await page.evaluate(() => {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:16px;top:28px;display:flex;gap:7px;z-index:2147483647;pointer-events:none';
        for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
          const light = document.createElement('span');
          light.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};border:1px solid #0003`;
          box.append(light);
        }
        document.body.append(box);
      });
      await page.screenshot({ path: join(evidence, `${phase}-${name}-${theme}.png`) });
      results.push({ name, theme, ...measurement });
    }
    await context.close();
  }
} finally {
  await browser.close();
  writeFileSync(join(evidence, `${phase}-geometry.json`), JSON.stringify(results, null, 2));
}
assert.equal(results.length, 12);
for (const result of results) {
  assert(result.bodyText, `${result.name} has no visible content`);
  assert(result.top >= 52 && result.drag, `${result.name} ${result.theme}: top=${result.top} drag=${result.drag}`);
}
console.log(`PASS ${results.length} screenshots and desktop titlebar checks`);
