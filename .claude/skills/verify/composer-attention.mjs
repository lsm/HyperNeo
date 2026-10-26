import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run, executablePath, modulePath] = process.argv.slice(2);
assert.notEqual(port, '8399');
const { chromium } = createRequire(import.meta.url)(modulePath || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath });
const observed = [];
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'en-US' });
    try {
      await page.goto(`http://127.0.0.1:${port}/neo`);
      if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
      const card = page.locator('[data-ask="composer-fixture"]:visible');
      await card.locator('[data-ask-focused-session] button').click();
      const pane = page.locator('.neo-session-pane');
      const input = pane.getByRole('textbox', { name: 'Message this chat', exact: true });
      await input.waitFor();
      const form = pane.locator('form.neo-composer-input');
      await page.request.get(`http://127.0.0.1:${port}/fixture?state=working`);
      const stop = form.getByRole('button', { name: 'Stop', exact: true });
      await stop.waitFor();
      assert.equal(await input.inputValue(), '');
      assert.equal(await form.getByRole('button', { name: 'Send message', exact: true }).count(), 0);
      assert.equal(await input.evaluate(el => document.activeElement === el), false);
      await page.screenshot({ path: `${run}/evidence/session-stop-${width}.png`, animations: 'disabled' });
      await stop.click();
      await stop.waitFor({ state: 'hidden' });
      const cases = [];
      for (const mode of ['waiting', 'error']) {
        await page.request.get(`http://127.0.0.1:${port}/fixture?state=${mode}`);
        const status = form.locator('.neo-composer-status');
        await status.getByText(mode === 'error' ? 'needs you' : 'A quick question for you above.', { exact: true }).waitFor();
        const metrics = await form.evaluate(el => {
          const box = el.getBoundingClientRect(), status = el.querySelector('.neo-composer-status').getBoundingClientRect();
          return { height: box.height, paddingTop: parseFloat(getComputedStyle(el).paddingTop), statusInset: status.x - box.x, statusBottomInset: box.bottom - status.bottom, x: box.x, right: box.right };
        });
        assert(metrics.height > 48 && metrics.paddingTop >= 12 && metrics.statusInset >= 12 && metrics.statusBottomInset >= 12, JSON.stringify(metrics));
        assert(metrics.x >= -1 && metrics.right <= width + 1);
        await page.screenshot({ path: `${run}/evidence/session-${mode}-${width}.png`, animations: 'disabled' });
        cases.push({ mode, metrics });
      }
      await page.request.get(`http://127.0.0.1:${port}/fixture?state=idle`);
      await page.waitForFunction(() => document.querySelector('.neo-session-pane .neo-composer-input.is-collapsed'));
      assert.equal((await form.boundingBox()).height, 48);
      observed.push({ width, stopReachableWithoutFocus: true, stopClicked: true, cases, idleCapsuleRestored: true });
    } finally { await page.close(); }
  }
} finally {
  writeFileSync(`${run}/evidence/attention.json`, JSON.stringify(observed, null, 2));
  await browser.close();
}
