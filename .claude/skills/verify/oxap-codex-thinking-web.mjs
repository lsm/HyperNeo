import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pairMessageCopyBrowser } from './neo-whole-message-copy-web.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const [port, pairCode, luna, sol, output] = process.argv.slice(2);
const pairBase = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: process.env.VERIFY_BROWSER });
const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
try {
  const storageState = await pairMessageCopyBrowser(browser, { pairBase, pairCode });
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      storageState,
      viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      hasTouch: touch,
      colorScheme: touch ? 'dark' : 'light',
    });
    const page = await context.newPage();
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch);
    const use = (control) => touch ? control.tap() : control.click();
    for (const [name, sessionId, title] of [
      ['gpt-6-luna', luna, 'GPT-6 Luna'],
      ['gpt-6.2-sol', sol, 'GPT-6.2 Sol'],
    ]) {
      await page.goto(`${pairBase}/session/${sessionId}`);
      await page.getByText(title, { exact: true }).first().waitFor();
      await use(page.getByRole('button', { name: 'Choose model and thinking' }));
      const slider = page.getByRole('slider', { name: 'Thinking' });
      await slider.waitFor({ timeout: 5000 });
      assert.equal(await slider.getAttribute('min'), '0');
      assert.equal(await slider.getAttribute('max'), String(levels.length - 1));
      assert.equal(await slider.getAttribute('step'), '1');
      const stops = await slider.locator('..').locator('[title]').evaluateAll(
        (ticks) => ticks.map((tick) => tick.getAttribute('title'))
      );
      assert.deepEqual(stops, levels);
      assert.equal(await page.getByText('OXAP cannot send ultra.', { exact: true }).count(), name === 'gpt-6.2-sol' ? 1 : 0);
      if (name === 'gpt-6-luna' && !touch) await slider.press('End');
      await page.getByRole('img', { name: 'Thinking: max', exact: true }).waitFor();
      assert.equal(await slider.getAttribute('aria-valuetext'), 'max');
      assert.equal(await page.getByTestId('thinking-slider-label').textContent(), 'max');
      await page.screenshot({ path: `${output}/${name}-${touch ? 'phone' : 'desktop'}.png`, animations: 'disabled' });
    }
    await context.close();
  }
  console.log('Four real Codex catalog screenshots verified');
} finally {
  await browser.close();
}
process.exit(0);
