import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert.notEqual(port, '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = [];
try {
  for (const width of [402, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 874 } });
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}/neo`);
    const input = page.locator('textarea#neo-thought');
    await input.fill('Keep my draft');
    if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
    const card = page.locator('[data-ask="a-api"]:visible');
    await card.getByRole('button', { name: 'Ask actions' }).click();
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const rect = document.querySelector('[role=menu]')?.getBoundingClientRect();
      return rect && rect.left >= 0 && rect.right <= innerWidth;
    });
    await page.screenshot({ path: `${run}/evidence/web-menu-${width}.png`, animations: 'disabled' });
    await page.getByRole('menuitem', { name: 'Reply', exact: true }).click();
    const quote = page.getByRole('region', { name: /^Replying to Neo/ });
    await quote.waitFor();
    assert((await quote.innerText()).includes('Draft the iOS API client'));
    assert.equal(await input.inputValue(), 'Keep my draft');
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    if (width < 800) assert.equal(await page.getByRole('button', { name: /^Your work/ }).getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: `${run}/evidence/web-composer-${width}.png`, animations: 'disabled' });
    evidence.push({ width, quote: await quote.innerText(), draft: await input.inputValue(), focused: true });
    await page.close();
  }
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify(evidence, null, 2));
}
