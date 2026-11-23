import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const [port, evidence, expect = 'expect-click'] = process.argv.slice(2);
assert(port && port !== '8399' && evidence && process.env.PAIR_CODE);
assert(['expect-click', 'expect-auto'].includes(expect));
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const result = { expect, opens: [] };
try {
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, {
    headers: { origin: base }, data: { code: process.env.PAIR_CODE, name: 'Synthetic browser' },
  });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState, locale: 'en-US' });
  await context.route(/^https:\/\/auth\.openai\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Synthetic consent</title>' }));
  await context.exposeBinding('recordOpen', (_source, entry) => result.opens.push(entry));
  await context.addInitScript(() => {
    const open = window.open.bind(window);
    window.open = (url, ...rest) => {
      window.recordOpen({ host: new URL(String(url), location.href).host, userActivation: navigator.userActivation.isActive });
      return open(url, ...rest);
    };
  });
  const page = await context.newPage();
  await page.goto(`${base}/settings?tab=providers`);
  await page.getByRole('button', { name: 'Add Provider' }).click();
  const row = page.locator('div', { hasText: 'OpenAI Codex' }).filter({ has: page.getByRole('button', { name: 'Connect' }) }).last();
  await row.getByRole('button', { name: 'Connect' }).click();
  const open = page.getByRole('button', { name: 'Open Auth URL' });
  await open.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  result.opensBeforeClick = result.opens.length;
  result.modalText = (await page.getByRole('dialog').last().innerText()).split('\n').slice(0, 4);
  await page.screenshot({ path: `${evidence}/provider-oauth-${expect}-modal.png`, animations: 'disabled' });
  const popup = context.waitForEvent('page', { timeout: 10000 });
  await open.click();
  await (await popup).waitForLoadState();
  result.opensAfterClick = result.opens.length;
  if (expect === 'expect-click') {
    assert.equal(result.opensBeforeClick, 0, 'the consent page opened before the user clicked');
    assert.equal(result.opensAfterClick, 1);
    assert.equal(result.opens[0].userActivation, true, 'the consent page opened without a user gesture');
    assert(!result.modalText.join(' ').includes('tab that opened'));
  } else {
    assert.equal(result.opensBeforeClick, 1, 'the old flow should open the consent page on its own');
  }
  result.passed = true;
} catch (error) {
  result.error = String(error);
  throw error;
} finally {
  await writeFile(`${evidence}/provider-oauth-${expect}.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
