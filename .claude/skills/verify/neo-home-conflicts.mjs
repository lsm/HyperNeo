import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert.notEqual(port, '8399');
const evidence = JSON.parse(readFileSync(`${run}/evidence/neo-home-conflicts.json`, 'utf8'));
const document = evidence.questions[0].document;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const results = [];
try {
 for (const width of [1280, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/neo`);
  if (width === 390) await page.getByRole('button', { name: /^Your work/ }).click();
  const card = page.locator(`[data-ask="${evidence.askId}"]:visible`);
  await card.waitFor();
  await page.screenshot({ path: `${run}/evidence/loaded-${width}.png`, fullPage: true });
  writeFileSync(`${run}/evidence/card-${width}.txt`, await card.innerText());
  await card.locator(`[data-ask-question="${evidence.questionId}"]`).waitFor();
  await card.locator('[data-ask-question] p').filter({ hasText: 'Home sync conflict:' }).waitFor();
  await card.locator('pre code').waitFor();
  assert((await card.innerText()).includes('direction.md'));
  assert((await card.innerText()).includes('Human local choice'));
  assert((await card.innerText()).includes('Other machine choice'));
  assert(!(await card.innerText()).includes('Remote full line\nRemote full line'));
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.waitForFunction((id) => { const cards = [...document.querySelectorAll(`[data-ask="${id}"]`)]; return cards.some((card) => { const r = card.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1; }); }, evidence.askId);
  const bounds = await card.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
  await page.screenshot({ path: `${run}/evidence/conflict-card-${width}.png`, fullPage: true });
  await card.getByRole('button', { name: 'View full report' }).click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  await dialog.evaluate(async (element) => { await Promise.all(element.parentElement.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))); });
  assert.equal(await dialog.locator('pre').textContent(), document);
  assert.equal(await dialog.locator('script').count(), 0);
  assert((await dialog.innerText()).includes(evidence.localHead));
  assert((await dialog.innerText()).includes(evidence.remoteHead));
  await page.screenshot({ path: `${run}/evidence/conflict-document-${width}.png`, fullPage: true });
  await dialog.locator('pre').evaluate((element) => { element.parentElement.scrollTop = element.parentElement.scrollHeight; });
  await page.screenshot({ path: `${run}/evidence/conflict-document-end-${width}.png`, fullPage: true });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert(await card.getByRole('button', { name: /Keep local$/ }).isEnabled());
  results.push({ width, bounds, fullTextExact: true, markupLiteral: true, answerControlsEnabled: true });
  await page.close();
 }
 writeFileSync(`${run}/evidence/neo-home-conflicts-web.json`, JSON.stringify(results, null, 2));
 console.log('PASS: actual /neo question and full-version document at desktop and phone widths.');
} finally { await browser.close(); }
