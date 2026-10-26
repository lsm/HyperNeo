import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run] = process.argv.slice(2);
assert(port && port !== '8399');
const saved = JSON.parse(readFileSync(`${run}/evidence/observed.json`, 'utf8'));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const observed = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/neo`);
      if (width === 390) await page.getByRole('button', { name: /^Your work/ }).click();
      const card = page.locator(`[data-ask="${saved.askId}"]:visible`);
      await card.waitFor();
      assert.equal(await card.locator('[data-ask-question]').count(), 0);
      const header = card.locator('[data-ask-focused-session]');
      assert((await header.innerText()).includes(saved.source.name));
      assert((await header.innerText()).includes(saved.source.provider));
      await page.waitForFunction(({ id, width }) => {
        const element = document.querySelector(`[data-ask="${id}"] [data-ask-focused-session]`);
        if (!element) return false;
        const box = element.getBoundingClientRect();
        return box.x >= 0 && box.right <= width + 1;
      }, { id: saved.askId, width });
      if (saved.outcomeMode) {
        await card.getByRole('button', { name: /Details$/ }).click();
        await card.getByRole('link', { name: 'Positioning document', exact: true }).waitFor();
        assert.equal(await card.getByRole('link', { name: 'Positioning document', exact: true }).getAttribute('href'), 'https://example.test/positioning.md');
        assert.equal(await card.getByRole('link', { name: 'Implementation PR', exact: true }).getAttribute('href'), 'https://github.com/example/project/pull/8');
        assert((await card.innerText()).includes('Decision: prioritize beginner gardeners.'));
        const execution = card.locator(`[data-ask-todo="${saved.outcomeEvidence.execution.todo.id}"]`);
        assert.equal(await execution.getAttribute('data-todo-state'), 'todo');
      }
      await page.screenshot({ path: `${run}/evidence/ask-${width}.png`, fullPage: true, animations: 'disabled' });
      await header.getByRole('button', { name: 'Open session: Positioning discussion', exact: true }).click();
      const pane = page.locator('.neo-session-pane');
      await pane.getByRole('heading', { name: saved.source.label, exact: true }).waitFor();
      await page.screenshot({ path: `${run}/evidence/session-${width}.png`, fullPage: true, animations: 'disabled' });
      await pane.getByRole('button', { name: 'Back to Neo', exact: true }).click();
      await header.getByRole('button', { name: 'Open session: Positioning discussion', exact: true }).waitFor();
      observed.push({ width, outcomeLinksVisible: !!saved.outcomeMode, questionRetired: true, reopened: saved.source.link, survivesBack: true });
    } finally { await page.close(); }
  }
  writeFileSync(`${run}/evidence/web.json`, JSON.stringify(observed, null, 2));
} finally { await browser.close(); }
