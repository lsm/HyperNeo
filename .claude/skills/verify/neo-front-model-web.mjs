import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pairMessageCopyBrowser } from './neo-whole-message-copy-web.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let page;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER,
});
try {
  const storageState = await pairMessageCopyBrowser(browser, fixture);
  const context = await browser.newContext({ storageState });
  page = await context.newPage();
  page.on('pageerror', (error) => console.error('Browser error', error.message));
  await page.goto(fixture.url);
  const region = page.getByRole('region', { name: 'Front model', exact: true });
  await region.getByText(/^front-fixture ·/).waitFor();
  const toggle = page.getByRole('checkbox', { name: 'Fast replies for text and voice' });
  assert.equal(await toggle.isChecked(), false);
  await region.getByRole('button', { name: 'Choose front model' }).click();
  await page.getByRole('button', { name: 'coordinator-fixture', exact: true }).click();
  await region.getByText(/^coordinator-fixture ·/).waitFor();
  assert.equal(await toggle.isChecked(), false);
  await page.reload();
  await region.getByText(/^coordinator-fixture ·/).waitFor();
  assert.equal(await toggle.isChecked(), false);
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished)
    );
  });
  await page.screenshot({ path: `${fixture.evidence}/front-model.png`, fullPage: true });
  writeFileSync(
    `${fixture.evidence}/browser.json`,
    JSON.stringify({ passed: true, persistedAfterReload: true, switchOff: true })
  );
  await context.close();
} catch (error) {
  if (page) {
    writeFileSync(
      `${fixture.evidence}/browser-failure.txt`,
      await page.locator('body').innerText()
    );
    await page.screenshot({ path: `${fixture.evidence}/browser-failure.png`, fullPage: true });
  }
  throw error;
} finally {
  await browser.close();
}
