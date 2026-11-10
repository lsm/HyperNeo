import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert.notEqual(port, '8399');
const fixture = JSON.parse(readFileSync(`${run}/fixture.json`, 'utf8'));
const credential = readFileSync(`${run}/data/local-rpc.credential`, 'utf8').trim();
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observed = [];
try {
  for (const width of [1280, 390]) {
    for (const language of ['en', 'zh-CN']) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale: language,
        permissions: ['clipboard-read', 'clipboard-write'],
        extraHTTPHeaders: { Authorization: `Bearer ${credential}` },
      });
      const page = await context.newPage();
      const operations = [];
      page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
        const request = JSON.parse(String(payload));
        if (request.data?.name) operations.push(request.data.name);
      }));
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
        ? route.continue() : route.abort());
      await page.goto(`http://127.0.0.1:${port}/neo?key=synthetic#card`);
      const card = page.locator(`[data-ask="${fixture.askId}"]`);
      if (width < 800) {
        await page.getByRole('button', { name: language === 'en' ? 'Your work' : '你的事', exact: false }).click();
      }
      await card.waitFor({ state: 'visible' });
      const label = language === 'en' ? 'Copy link' : '复制链接';
      await card.getByRole('button', { name: language === 'en' ? 'Ask actions' : '更多操作' }).click();
      await page.getByRole('menuitem', { name: label, exact: true }).waitFor();
      await page.waitForFunction(() => !document.getAnimations().some(animation =>
        animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity));
      const bounds = await page.getByRole('menu').evaluate(menu => {
        const rect = menu.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: innerWidth };
      });
      writeFileSync(`${run}/evidence/menu-bounds-${language}-${width}.json`, JSON.stringify(bounds));
      assert(bounds.left >= 0 && bounds.right <= bounds.width, 'The settled menu must fit the viewport');
      await page.screenshot({ path: `${run}/evidence/menu-${language}-${width}.png`, animations: 'disabled' });
      const url = page.url();
      const count = operations.length;
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(copied, `[${fixture.label}](${new URL(url).origin}/ask/${fixture.askId}.md)`);
      assert.equal(copied.split('\n').length, 1);
      assert.equal(page.url(), url);
      assert.deepEqual(operations.slice(count), []);
      const target = copied.slice(copied.lastIndexOf('](') + 2, -1);
      const response = await context.request.get(target);
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-type'], /^text\/markdown/);
      assert.equal(response.headers()['cache-control'], 'no-store');
      assert((await response.text()).startsWith(`# ${fixture.label}\n`));
      await page.getByRole('menuitem', { name: label, exact: true }).waitFor({ state: 'hidden' });
      observed.push({ width, language, copied, stayedOnCard: true, extraOperations: [], targetStatus: 200, targetType: 'text/markdown' });
      await context.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify({ observed, passed: observed.length === 4 }, null, 2));
}
