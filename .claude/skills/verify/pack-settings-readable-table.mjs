import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const { askId, question, language } = JSON.parse(readFileSync(`${run}/fixture.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observations = [];
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width === 390) await page.getByRole('button', { name: /^(Your work|你的工作|工作)/ }).click();
    const card = page.locator(`[data-ask="${askId}"]:visible`);
    await card.waitFor();
    const body = card.locator(`[id="neo-ref-question-${question.id}"]`);
    await body.waitFor();
    if (width === 390) await page.waitForFunction(() => Math.abs(document.querySelector('.neo-scene-sheet').getBoundingClientRect().x) < 0.1);
    await page.screenshot({ path: `${run}/evidence/table-${language}-${width}.png`, fullPage: true });
    const observation = { width, text: await body.innerText(), tables: await body.locator('table').count(), headings: await body.locator('h3').allTextContents(), rows: await body.locator('tbody tr').allTextContents() };
    observations.push(observation);
    writeFileSync(`${run}/evidence/table-${language}.json`, JSON.stringify(observations, null, 2));
    assert.equal(observation.tables, 2);
    assert.deepEqual(observation.headings, ['synthetic/one', 'synthetic/two']);
    assert.equal(observation.rows.length, 4);
    assert(observation.text.includes(language === 'en' ? 'CI and review bot approval' : 'CI 通过且审查机器人批准'));
    assert(observation.text.includes('synthetic-bot'));
    assert(observation.text.includes('docs/**'));
    assert(!observation.text.includes('review_bot'));
    const bounds = await body.boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    if (width === 390) {
      await body.getByRole('button', { name: question.yesLabel, exact: true }).click();
      await card.locator('[data-ask-details-toggle]').click();
      await card.locator(`[id="neo-ref-question-${question.id}"]`).waitFor();
    }
    await page.close();
  }
} finally { await browser.close(); }
