import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run] = process.argv.slice(2);
assert(!['8399', '8499'].includes(port));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observed = [];
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 874 } });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
    const work = page.getByRole('region', { name: 'Work scenes' });
    await work.locator('[data-ask]').nth(79).waitFor();
    assert.equal(await work.locator('[data-ask]').count(), 80);
    assert.equal(await work.locator('[data-ask="busy-done-00"]').count(), 0);
    await page.screenshot({ path: `${run}/evidence/recent-${width}.png`, fullPage: true });
    for (const count of [100, 120, 134]) {
      await work.getByRole('button', { name: 'Show older outcomes', exact: true }).click();
      await work.locator('[data-ask]').nth(count - 1).waitFor();
      assert.equal(await work.locator('[data-ask]').count(), count);
    }
    assert.equal(await work.getByRole('button', { name: 'Show older outcomes', exact: true }).count(), 0);
    const oldest = work.locator('[data-ask="busy-done-00"]');
    await oldest.locator('[data-ask-details-toggle]').click();
    await oldest.getByText('Full synthetic instruction', { exact: true }).waitFor();
    await page.screenshot({ path: `${run}/evidence/history-${width}.png`, fullPage: true });
    observed.push({ width, initial: 80, paged: 134, fullDetails: true });
    await page.close();
  }
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify({ passed: true, observed }, null, 2));
} finally { await browser.close(); }
