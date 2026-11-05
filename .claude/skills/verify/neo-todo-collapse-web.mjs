import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function verifyTodoCollapse(page, { port, run, width }) {
  assert.notEqual(String(port), '8399');
  mkdirSync(`${run}/evidence`, { recursive: true });
  const observed = { width, steps: [] };
  const record = (step) => { observed.steps.push(step); writeFileSync(`${run}/evidence/todo-collapse-${width}.json`, JSON.stringify(observed, null, 2)); };
  await page.goto(`http://127.0.0.1:${port}/neo`);
  if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
  const card = page.locator('[data-ask="collapse-card"]:visible');
  const other = page.locator('[data-ask="other-card"]:visible');
  await card.waitFor();
  await card.screenshot({ path: `${run}/evidence/todo-collapsed-${width}.png` });
  record({ name: 'initial', details: await card.locator('[data-todo-details]').count(), all: await card.getByRole('button', { name: /^All · / }).count() });
  assert.equal(observed.steps[0].all, 1, 'card needs one All dialog control');
  assert.equal(await card.locator('[data-todo-details]').count(), 0);
  const first = () => card.getByRole('button', { name: /details: Synthetic step 1$/ });
  await first().focus(); await page.keyboard.press('Enter');
  await card.locator('[data-todo-details]').waitFor();
  assert.equal(await card.locator('[data-todo-details]').count(), 1);
  assert((await card.locator('[data-todo-details]').innerText()).includes('Report 1:'));
  assert.equal(await other.locator('[data-todo-details]').count(), 0);
  record({ name: 'keyboard-expand-one', details: 1, otherDetails: 0 });
  await page.keyboard.press('Space');
  assert.equal(await card.locator('[data-todo-details]').count(), 0);
  for (let index = 1; index <= 3; index++) {
    await card.getByRole('button', { name: new RegExp(`details: Synthetic step ${index}$`) }).click();
  }
  assert.equal(await card.locator('[data-todo-details]').count(), 3);
  await page.screenshot({ path: `${run}/evidence/todo-expanded-${width}.png` });
  const lastDetail = card.locator('[data-todo-details]').last();
  await lastDetail.scrollIntoViewIfNeeded();
  assert((await lastDetail.innerText()).includes('Evidence 3:'));
  await page.screenshot({ path: `${run}/evidence/todo-expanded-last-${width}.png` });
  assert.equal(await other.locator('[data-todo-details]').count(), 0);
  record({ name: 'expand-each', details: 3, otherDetails: 0 });
  for (let index = 1; index <= 3; index++) {
    await card.getByRole('button', { name: new RegExp(`details: Synthetic step ${index}$`) }).click();
  }
  assert.equal(await card.locator('[data-todo-details]').count(), 0);
  assert.equal(await first().getAttribute('aria-expanded'), 'false');
  record({ name: 'collapse-each-including-first', details: 0 });
  await first().click();
  await page.reload();
  if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
  await card.waitFor();
  assert.equal(await card.locator('[data-todo-details]').count(), 1);
  assert.equal(await other.locator('[data-todo-details]').count(), 0);
  record({ name: 'session-reload', details: 1, otherDetails: 0 });
  await first().click();
  const status = card.locator('[data-todo-status]').first();
  const layout = await status.evaluate((node) => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight), whiteSpace: getComputedStyle(node).whiteSpace }));
  assert(layout.height <= layout.lineHeight + 1 && layout.whiteSpace === 'nowrap', JSON.stringify(layout));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await card.screenshot({ path: `${run}/evidence/todo-final-${width}.png` });
  record({ name: 'single-line-and-fit', layout, details: 0 });
  return observed;
}

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [port, run] = process.argv.slice(2);
  assert(port && run, 'usage: neo-todo-collapse-web.mjs <port> <run>');
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', isMobile: width < 800, hasTouch: width < 800 });
      await verifyTodoCollapse(await context.newPage(), { port, run, width });
      await context.close();
    }
  } finally { await browser.close(); }
}
