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
        return { path: location.pathname, bottom: root?.getBoundingClientRect().bottom, desktop: document.documentElement.classList.contains('tauri-desktop'), bodyText: document.body.innerText.slice(0, 100), top: root?.getBoundingClientRect().top, drag: hit?.hasAttribute('data-tauri-drag-region') ?? false };
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
        const rect = box.getBoundingClientRect();
        if (rect.left !== 16 || rect.top !== 28) throw new Error(`Traffic lights misplaced: ${rect.left}, ${rect.top}`);
      });
      await page.screenshot({ path: join(evidence, `${phase}-${name}-${theme}.png`), mask: [page.getByTestId('chat-header-folder')], maskColor: '#888888' });
      if (name === 'session') {
        const trigger = page.getByTestId('chat-menu-btn');
        await trigger.click();
        const menu = page.getByRole('menu');
        await menu.waitFor();
        await page.waitForTimeout(500);
        const triggerBox = await trigger.boundingBox();
        const menuBox = await menu.boundingBox();
        measurement.menuGap = menuBox.y - (triggerBox.y + triggerBox.height);
        await page.screenshot({ path: join(evidence, `${phase}-menu-${theme}.png`), mask: [page.getByTestId('chat-header-folder')], maskColor: '#888888' });
        await page.keyboard.press('Escape');
      }
      results.push({ name, theme, expectedPath: route, ...measurement });
    }
    await page.goto(`${base}/settings?tab=neo-model`);
    const limit = page.getByRole('spinbutton', { name: 'Running steps in total' });
    await limit.fill('0');
    await limit.press('Tab');
    const toast = page.getByRole('alert').filter({ hasText: 'Enter a whole number of at least 1' });
    const dismiss = toast.getByRole('button', { name: 'Dismiss notification' });
    await dismiss.waitFor();
    await page.waitForTimeout(500);
    const toastGeometry = await dismiss.evaluate(el => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { top: box.top, hit: hit === el || el.contains(hit) };
    });
    await page.screenshot({ path: join(evidence, `${phase}-toast-${theme}.png`) });
    assert(toastGeometry.top >= 52 && toastGeometry.hit, `Toast covered: ${JSON.stringify(toastGeometry)}`);
    await dismiss.click();
    await toast.waitFor({ state: 'detached' });
    await context.close();
  }
  const browserContext = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 } });
  const browserPage = await browserContext.newPage();
  for (const route of ['/neo', '/sessions', '/pair']) {
    await browserPage.goto(`${base}${route}`);
    await browserPage.locator('#root').waitFor({ state: 'attached' });
    await browserPage.waitForTimeout(1000);
    assert.equal(await browserPage.locator('.desktop-drag-strip').count(), 0);
    assert.equal(await browserPage.evaluate(() => document.documentElement.classList.contains('tauri-desktop')), false);
  }
  await browserContext.close();
} finally {
  await browser.close();
  writeFileSync(join(evidence, `${phase}-geometry.json`), JSON.stringify(results, null, 2));
}
assert.equal(results.length, 12);
for (const result of results) {
  assert.equal(result.path, result.expectedPath);
  assert(result.bottom <= 900, `${result.name}: bottom=${result.bottom}`);
  assert(result.desktop, `${result.name}: desktop class missing`);
  assert(result.bodyText, `${result.name} has no visible content`);
  if (result.name === 'session') assert(Math.abs(result.menuGap - 4) <= 2, `Chat menu gap: ${result.menuGap}`);
  assert(result.top >= 52 && result.drag, `${result.name} ${result.theme}: top=${result.top} drag=${result.drag}`);
}
console.log(`PASS ${results.length} screenshots and desktop titlebar checks`);
