import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && port !== '8399');
const run = resolve(directory);
const saved = JSON.parse(readFileSync(`${run}/evidence/source-session.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const observed = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/neo`);
      if (width === 390) await page.getByRole('button', { name: /^Your work/ }).click();
      const question = page.locator(`[data-ask-question="${saved.source.question.id}"]:visible`);
      await question.waitFor();
      const header = question.locator('[data-question-source]');
      assert.equal(await header.innerText(), 'Open');
      assert.equal(await header.locator('svg').count(), 1);
      const joined = page.locator(`[data-ask-question="${saved.start.question.id}"]:visible`);
      assert.equal(await joined.locator('[data-question-source]').innerText(), 'Open');
      await joined.getByRole('button', { name: 'Open session: Review worker', exact: true }).click();
      await page.locator('.neo-session-pane').getByRole('heading', { name: 'HyperNeo · Review worker', exact: true }).waitFor();
      await page.locator('.neo-session-pane').getByRole('button', { name: 'Back to Neo', exact: true }).click();
      const linkless = page.locator('[data-ask-question="linkless-source"]:visible');
      assert.equal(await linkless.locator('[data-question-source]').count(), 0);
      assert.equal(await linkless.getByRole('button', { name: /^Open session:/ }).count(), 0);
      const ordinary = page.locator(`[data-ask-question="${saved.ordinary.question.id}"]:visible`);
      assert.equal(await ordinary.getByRole('button', { name: /^Open session:/ }).count(), 0);
      await page.waitForFunction(({ id, width }) => {
        const element = document.querySelector(`[data-ask-question="${id}"] [data-question-source]`);
        if (!element) return false;
        const box = element.getBoundingClientRect();
        return box.x >= 0 && box.right <= width + 1;
      }, { id: saved.source.question.id, width });
      const bounds = await header.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${run}/evidence/question-source-${width}.png`, fullPage: true });
      await question.getByRole('button', { name: 'Open session: Review worker', exact: true }).click();
      const pane = page.locator('.neo-session-pane');
      await pane.getByRole('heading', { name: 'HyperNeo · Review worker', exact: true }).waitFor();
      await page.screenshot({ path: `${run}/evidence/question-source-open-${width}.png`, fullPage: true });
      await pane.getByRole('button', { name: 'Back to Neo', exact: true }).click();
      await question.getByRole('button', { name: 'Approve', exact: true }).waitFor();
      if (width === 390) {
        await question.getByRole('button', { name: 'Approve', exact: true }).click();
        const raw = execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'neo.question.get', JSON.stringify({ questionId: saved.source.question.id })], { env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8' });
        const result = JSON.parse(raw).reply;
        assert.equal(result.question.state, 'answered');
        assert.equal(result.question.answer, 'yes');
        assert.deepEqual(result.question.sourceSession, saved.source.question.sourceSession);
      }
      observed.push({ width, header: 'Open', bounds, adapterOpener: '/session/source-worker', ordinaryHasNoOpener: true, answerControlsPreserved: true, joinedStartHasWorkingOpener: true, linklessHeaderAbsent: true });
    } finally { await page.close(); }
  }
  writeFileSync(`${run}/evidence/question-source-web.json`, JSON.stringify(observed, null, 2));
  console.log('PASS: logo + Open button without source title/provider, adapter opener and answer controls at desktop/mobile widths');
} finally { await browser.close(); }
