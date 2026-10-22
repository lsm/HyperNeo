import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, phase] = process.argv.slice(2);
assert(port && run && ['before', 'after'].includes(phase));
assert.notEqual(String(port), '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const out = `${run}/evidence/${phase}`;
mkdirSync(out, { recursive: true });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', isMobile: width < 800, hasTouch: width < 800 });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/neo`);
      if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
      const card = page.locator('[data-ask="collapse-card"]:visible');
      await card.waitFor();
      const rows = card.locator('[data-ask-todo]');
      assert.equal(await rows.count(), 3);
      assert.equal(await card.locator('[data-worker-label]').count(), 1);
      assert.equal(await card.getByRole('button', { name: /^Open / }).count(), 1);
      const measure = () => rows.evaluateAll(nodes => nodes.map(row => {
        const button = row.querySelector('button[aria-expanded]');
        const status = row.querySelector('[data-todo-status]');
        const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, width:r.width, height:r.height }; };
        const word = button.querySelector('.sr-only');
        return { row:rect(row), status:rect(status), control:rect(button), label:button.getAttribute('aria-label'), expanded:button.getAttribute('aria-expanded'), glyph:button.querySelector('[aria-hidden]')?.textContent, hiddenWord:word ? getComputedStyle(word).position : null, color:getComputedStyle(button).color };
      }));
      const before = await measure();
      await card.screenshot({ path:`${out}/todo-collapsed-${width}.png` });
      const first = card.getByRole('button', { name:/details: Synthetic step 1$/ });
      await first.focus(); await page.keyboard.press('Enter');
      await card.locator('[data-todo-details]').waitFor();
      assert.equal(await card.locator('[data-todo-details]').count(), 1);
      const focusRetained = await first.evaluate(node => node === document.activeElement);
      if (phase === 'after') assert(focusRetained);
      const expanded = await measure();
      await card.screenshot({ path:`${out}/todo-expanded-${width}.png` });
      if (!focusRetained) await first.focus();
      await page.keyboard.press('Space');
      assert.equal(await card.locator('[data-todo-details]').count(), 0);
      if (phase === 'after') assert(await first.evaluate(node => node === document.activeElement));
      await card.getByRole('button', { name:'Expand all', exact:true }).click();
      assert.equal(await card.locator('[data-todo-details]').count(), 3);
      await card.getByRole('button', { name:'Collapse all', exact:true }).click();
      assert.equal(await card.locator('[data-todo-details]').count(), 0);
      const observation = { phase,width,before,expanded,keyboard:'Enter and Space pass',focusRetained,bulk:'Expand all / Collapse all pass' };
      writeFileSync(`${out}/todo-${width}.json`, JSON.stringify(observation,null,2));
      if (phase === 'after') {
        for (const [index, row] of before.entries()) {
          assert(Math.abs(row.control.right-row.row.right)<2, JSON.stringify(row));
          assert(Math.abs(row.status.x-before[0].status.x)<1, 'status text shares one left edge');
          assert.equal(row.control.width,28);
          assert.equal(row.glyph,'▾'); assert.equal(row.hiddenWord,'absolute');
          assert(Math.abs(expanded[index].control.x-row.control.x)<1, 'expansion keeps the action column');
          assert(Math.abs((expanded[index].control.y-expanded[index].row.y)-(row.control.y-row.row.y))<2, 'expansion keeps its row-top anchor');
        }
        assert.equal(expanded[0].glyph,'▴');
        assert(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth));
      }
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
