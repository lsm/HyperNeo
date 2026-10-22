import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifySdkSystem(page, { port, run, width, phase }) {
  assert(Number(port) !== 8399);
  const after = phase === 'after', dir = `${run}/evidence/${phase}`;
  await mkdir(dir, { recursive: true });
  const { worker } = JSON.parse(await readFile(`${run}/evidence/sdk-system-seed.json`, 'utf8'));
  await page.setViewportSize({ width, height: 1000 });
  const observed = { width, phase, cases: [] };
  for (const [title, label, detail] of [
    ['Memory recalled', 'Memory recalled', 'synthetic-memory.md'],
    ['synthetic-hook', 'synthetic-hook', 'Synthetic diagnostic'],
    ['Compact', 'Compact', 'Metadata:'],
    ['Show raw data', 'Show raw data', 'Synthetic raw evidence'],
  ]) {
    await page.goto(`http://127.0.0.1:${port}/session/${worker}`);
    const heading = page.getByText(title, { exact: true });
    const card = heading.locator(title === 'Show raw data' ? 'xpath=ancestor::details[1]' : 'xpath=ancestor::*[contains(@class,"rounded")][1]');
    await heading.waitFor();
    const control = () => after ? card.getByRole('button', { name: new RegExp(`^(more|less) — ${label}$`) }) : title === 'Show raw data' ? card.locator('summary') : card.getByRole('button').first();
    await heading.click();
    if (!after) await card.getByText(detail, { exact: title !== 'Show raw data' }).waitFor();
    const titleOpens = after ? (await control().getAttribute('aria-expanded')) === 'true' : await card.getByText(detail, { exact: title !== 'Show raw data' }).isVisible();
    if (!after) assert.equal(titleOpens, true);
    if (after) assert.equal(titleOpens, false);
    await page.screenshot({ path: `${dir}/${label}-title-${width}.png`, animations: 'disabled', scale: 'css' });
    if (!after) await control().click();
    await control().scrollIntoViewIfNeeded();
    await control().hover(); await page.mouse.wheel(0, -250);
    await control().scrollIntoViewIfNeeded(); await control().focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const beforeTop = await card.evaluate(el => el.getBoundingClientRect().top);
    await page.keyboard.press('Enter');
    await card.getByText(detail, { exact: title !== 'Show raw data' }).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const entry = { title, titleOpens, delta: (await card.evaluate(el => el.getBoundingClientRect().top)) - beforeTop };
    if (after) {
      assert.equal(await control().getAttribute('aria-expanded'), 'true');
      assert.equal(await control().evaluate(el => el === document.activeElement), true);
      assert(Math.abs(entry.delta) <= 2, `${label} moved ${entry.delta}px`);
      await card.getByText(detail, { exact: title !== 'Show raw data' }).click();
      assert.equal(await control().getAttribute('aria-expanded'), 'true');
    }
    await control().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${label}-open-${width}.png`, animations: 'disabled', scale: 'css' });
    if (after) {
      entry.placement = await control().evaluate(b => { const r = b.getBoundingClientRect(), p = b.closest('.flow-root').getBoundingClientRect();return {right:r.right,parentRight:p.right}; });
      assert(Math.abs(entry.placement.right - entry.placement.parentRight) <= 14);
      await page.keyboard.press('Space');
      assert.equal(await control().getAttribute('aria-expanded'), 'false');
      assert.equal(await control().evaluate(el => el === document.activeElement), true);
    } else await control().click();
    observed.cases.push(entry);
  }
  observed.viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(observed.viewport.width, observed.viewport.scrollWidth);
  await writeFile(`${dir}/observed-${width}.json`, JSON.stringify(observed, null, 2));
  return observed;
}
