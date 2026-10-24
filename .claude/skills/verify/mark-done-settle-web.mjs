import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, mode] = process.argv.slice(2);
assert.notEqual(port, '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = { mode, widths: [] };
let current;
try {
  for (const width of mode === 'before' ? [1280] : [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    current = page;
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
    const card = (id) => page.locator(`[data-ask="${id}"]:visible`);
    if (width === 1280) {
      await card('finish').getByRole('button', { name: 'Ask actions' }).click();
      await page.getByRole('menuitem', { name: 'Mark done' }).click();
      if (mode === 'before') {
        await page.getByRole('alert').filter({ hasText: 'todos_unfinished' }).waitFor();
        assert.equal(await card('finish').getByRole('alert').count(), 0);
        await page.screenshot({ path: `${run}/evidence/before.png` });
        evidence.refusedWithNoCardError = true;
        break;
      }
      await page.locator('[data-ask="finish"][data-ask-state="done"]:visible').waitFor();
      await card('finish').getByRole('button', { name: 'Ask actions' }).click();
      evidence.settledActions = await page.getByRole('menuitem').allTextContents();
      assert.deepEqual(evidence.settledActions, ['Reply']);
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'hidden' });
      await card('finish').screenshot({ path: `${run}/evidence/marked-done.png` });
    }
    await card('stop-failure').getByRole('button', { name: 'Ask actions' }).click();
    await page.getByRole('menuitem', { name: 'Mark done' }).click();
    const alert = card('stop-failure').getByRole('alert');
    await alert.waitFor();
    assert.match(await alert.innerText(), /still open/);
    assert.equal(await page.getByRole('alert').count(), 1);
    await card('stop-failure').screenshot({ path: `${run}/evidence/card-error-${width}.png` });
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    await card('stop-failure').getByRole('button', { name: 'Ask actions' }).click();
    await page.getByRole('menuitem', { name: 'Mark done' }).click();
    await alert.waitFor();
    evidence.widths.push({ width, cardError: await alert.innerText(), retry: true });
    await page.close();
  }
} catch (error) {
  if (current && !current.isClosed()) {
    writeFileSync(`${run}/evidence/failure.txt`, await current.locator('body').innerText());
    await current.screenshot({ path: `${run}/evidence/failure.png` });
  }
  throw error;
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/browser.json`, JSON.stringify(evidence, null, 2));
}
