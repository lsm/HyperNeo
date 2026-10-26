import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run, phase = 'after'] = process.argv.slice(2);
assert(port && run && ['before', 'after'].includes(phase));
assert.notEqual(String(port), '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const out = `${run}/evidence/${phase}`;
mkdirSync(out, { recursive: true });
const expected = ['waiting-a', 'waiting-b', 'waiting-old', 'blocked', 'queued', 'running', 'done'];
const observations = [];
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', isMobile: width < 800 });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/neo`);
      const openWork = async () => {
        if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
        await page.locator('[data-ask="waiting-a"]:visible').waitFor();
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
        });
      };
      const order = () => page.locator('[data-ask]:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-ask')));
      await openWork();
      const initial = await order();
      assert.equal(await page.locator('[data-ask="waiting-a"]:visible').getByText('Waiting on you', { exact: true }).count(), 1);
      await page.screenshot({ path: `${out}/waiting-order-${width}.png` });
      execFileSync('bun', ['.claude/skills/verify/waiting-card-order-seed.ts', run, 'update'], {
        env: { PATH: process.env.PATH, HOME: `${run}/home`, HYPERNEO_DATA_DIR: `${run}/data`, NODE_ENV: 'test' },
      });
      await page.reload();
      await openWork();
      const reloaded = await order();
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      observations.push({ width, initial, reloaded, fits });
      writeFileSync(`${out}/waiting-order.json`, JSON.stringify(observations, null, 2));
      assert(fits, 'no horizontal overflow');
      if (phase === 'after') {
        assert.deepEqual(reloaded, initial, 'unrelated status update and reload keep the same order');
        assert.deepEqual(initial, expected);
      }
      else assert(initial.indexOf('blocked') < initial.indexOf('waiting-a'), 'reproduce waiting below in-progress work');
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
