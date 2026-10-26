import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run] = process.argv.slice(2);
assert(port && port !== '8399');
const saved = JSON.parse(readFileSync(`${run}/evidence/observed.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/neo`);
      if (width === 390) await page.getByRole('button', { name: /^Your work/ }).click();
      const card = page.locator(`[data-ask-question="${saved.question.question.id}"]:visible`);
      await card.waitFor();
      await card.getByText('Prepared for discussion', { exact: true }).waitFor();
      assert((await card.innerText()).includes('Prepared for discussion'));
      assert.equal(await card.getByRole('button', { name: /^Open session/ }).count(), 1);
      await page.waitForFunction(({ id, width }) => {
        const element = document.querySelector(`[data-ask-question="${id}"]`);
        if (!element) return false;
        const box = element.getBoundingClientRect();
        return box.x >= 0 && box.right <= width + 1;
      }, { id: saved.question.question.id, width });
      await page.screenshot({ path: `${run}/evidence/prepared-${width}.png`, fullPage: true, animations: 'disabled' });
      await card.getByRole('button', { name: /^Open session/ }).click();
      const pane = page.locator('.neo-session-pane');
      await pane.getByRole('heading', { name: 'HyperNeo · Focused positioning discussion', exact: true }).waitFor();
      await pane.getByText(saved.report, { exact: true }).waitFor();
      await page.screenshot({ path: `${run}/evidence/session-${width}.png`, fullPage: true, animations: 'disabled' });
      await pane.getByRole('button', { name: 'Back to Neo', exact: true }).click();
      await card.getByRole('button', { name: 'Reply in chat', exact: true }).waitFor();
    } catch (error) {
      writeFileSync(`${run}/evidence/failed-${width}.txt`, await page.locator('body').innerText());
      await page.screenshot({ path: `${run}/evidence/failed-${width}.png`, fullPage: true, animations: 'disabled' });
      throw error;
    } finally { await page.close(); }
  }
  writeFileSync(`${run}/evidence/web.json`, JSON.stringify({ widths: [1440, 390], onePreparedCard: true, correctSession: true, preparedReplyVisible: true, answerControlPreserved: true }, null, 2));
} finally { await browser.close(); }
