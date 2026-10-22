import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const [port, run, mode = 'verify'] = process.argv.slice(2);
assert(Number(port) > 0 && Number(port) !== 8399);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
try {
  const observed = [];
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', isMobile: width < 800 });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
    const card = page.locator('[data-ask="worker-card"]:visible');
    await card.waitFor();
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
    });
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-ask="worker-card"]');
      const box = card?.getBoundingClientRect();
      return box && box.left >= 0 && box.right <= innerWidth && box.top < innerHeight;
    });
    const text = await card.innerText();
    await page.screenshot({ path: `${run}/evidence/worker-${mode}-${width}.png` });
    observed.push({ width, text, fits: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) });
    writeFileSync(`${run}/evidence/web-${mode}.json`, JSON.stringify(observed, null, 2));
    assert(observed.at(-1).fits);
    if (mode === 'reproduce') assert(!text.includes('Codex · Claude something'));
    else assert(text.includes(mode === 'renamed' ? 'Codex · fullstack-renamed' : 'Codex · Claude something'));
    await context.close();
  }
} finally { await browser.close(); }
