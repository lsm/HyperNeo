import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { pairMessageCopyBrowser } from './neo-whole-message-copy-web.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const evidence = `${fixture.run}/evidence`;
const observations = [];
try {
  const storageState = await pairMessageCopyBrowser(browser, fixture);
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, hasTouch: width === 390 });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    try {
      await page.goto(fixture.url);
      await page.getByText('Synthetic human request', { exact: true }).waitFor();
      const chat = page.getByRole('region', { name: 'Conversation with Neo', exact: true });
      assert.equal(await chat.locator('[data-wake]').count(), 0);
      assert.equal(await chat.locator('[data-session-schedules]').count(), 0);
      assert.equal((await chat.innerText()).includes(fixture.internal), false);
      assert.equal(await chat.getByText('Guide ready.', { exact: true }).count(), 1);
      const panel = page.locator('#neo-preview-work-panel');
      if (width === 390) await page.screenshot({ path: `${evidence}/chat-${width}.png`, fullPage: true });
      if (width === 390) await page.getByRole('button', { name: /^Your work(?:,.*)?$/ }).click();
      const completed = panel.locator(`[data-wake="${fixture.wake}"]`);
      await completed.waitFor({ state: 'visible' });
      assert.match(await completed.locator('summary').innerText(), /Completed/);
      assert.match(await panel.locator(`[data-wake="${fixture.active}"] summary`).innerText(), /Running/);
      assert.equal(await page.getByText(fixture.internal, { exact: true }).isVisible(), false);
      await completed.getByRole('button', { name: /more/i }).click();
      assert.equal(await completed.getByText(fixture.internal, { exact: true }).isVisible(), true);
      await completed.getByRole('button', { name: /less/i }).click();
      assert.equal(await page.getByText(fixture.internal, { exact: true }).isVisible(), false);
      await page.screenshot({ path: `${evidence}/conversation-${width}.png`, fullPage: true });
      observations.push({ width, chatWakes: 0, panelWakes: await panel.locator('[data-wake]').count(), replyCount: 1, settlementOnlyInDetails: true });
    } catch (error) {
      writeFileSync(`${evidence}/browser-failure.txt`, await page.locator('body').innerText());
      await page.screenshot({ path: `${evidence}/browser-failure.png`, fullPage: true });
      throw error;
    } finally { await context.close(); }
  }
  writeFileSync(`${evidence}/browser.json`, JSON.stringify({ passed: true, observations }, null, 2));
  console.log(JSON.stringify({ browserExit: 0, viewports: observations.length, observations }));
} finally { await browser.close(); }
