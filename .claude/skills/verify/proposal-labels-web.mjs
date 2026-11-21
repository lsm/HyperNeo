import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { revealAsk } from './queue-ask.mjs';

const [port, directory, language = 'zh-Hans'] = process.argv.slice(2);
assert(port && directory, 'usage: node proposal-labels-web.mjs <port> <run-dir> [zh-Hans|en]');
assert.notEqual(port, '8399');
const run = resolve(directory);
const evidence = join(run, 'evidence');
const base = `http://127.0.0.1:${port}`;
const pair = () =>
  execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic labels browser' })], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') },
  }).match(/"code":\s*"([^"]+)"/)?.[1];
const expected = language === 'en'
  ? { 'default-labels': ['Confirm', 'Cancel'], 'neo-labels': ['发出去', '先不做'] }
  : { 'default-labels': ['确定', '取消'], 'neo-labels': ['发出去', '先不做'] };
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const result = { language, views: [], passed: false };
try {
  for (const view of [
    { name: 'desktop', viewport: { width: 1280, height: 900 } },
    { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  ])
    for (const colorScheme of ['light', 'dark']) {
      const code = pair();
      assert(code, 'no pairing code');
      const context = await browser.newContext({ viewport: view.viewport, hasTouch: view.hasTouch, isMobile: view.isMobile, colorScheme, locale: language === 'en' ? 'en-US' : 'zh-CN' });
      await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/pair#${code}`);
      await page.getByRole('button', { name: 'Pair this browser' }).click();
      await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
      await page.goto(`${base}/neo`);
      await page.waitForTimeout(800);
      const work = page.getByRole('button', { name: /^(your work|你的事)/i });
      if (view.name === 'phone') {
        await work.click();
        await page.locator('[data-ask]:visible').first().waitFor({ timeout: 15000 });
      }
      const labels = {};
      for (const id of Object.keys(expected)) {
        const card = (await revealAsk(page, id)).first();
        await card.waitFor({ timeout: 15000 });
        const [yes, no] = expected[id];
        await card.getByRole('button', { name: yes, exact: true }).waitFor({ timeout: 10000 });
        await card.getByRole('button', { name: no, exact: true }).waitFor({ timeout: 10000 });
        labels[id] = [yes, no];
      }
      await page.waitForTimeout(1000);
      const shot = join(evidence, `proposal-labels-${language}-${view.name}-${colorScheme}.png`);
      await page.screenshot({ path: shot });
      result.views.push({ view: view.name, colorScheme, labels, errors, shot });
      assert.deepEqual(errors, []);
      await context.close();
    }
  result.passed = true;
} finally {
  writeFileSync(join(evidence, `proposal-labels-${language}.json`), JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(`PASS proposal labels ${language}: ${result.views.length} views`);
