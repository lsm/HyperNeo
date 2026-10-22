import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifySdkInit(page, { daemon, fixture, run, width, phase }) {
  assert(Number(daemon) !== 8399 && Number(fixture) !== 8399);
  const dir = `${run}/evidence/${phase}`, after = phase === 'after';
  await mkdir(dir, { recursive: true });
  const observed = { width, phase, surface: 'Component fixture only; no active runtime initialization caller', cases: [] };
  await page.setViewportSize({ width, height: 1000 });
  for (const [section, title, label] of [
    ['Direct component', 'Session Started', 'Session Started'],
    ['Gated component', 'synthetic-init-model', 'Session details'],
  ]) {
    await page.goto(`http://127.0.0.1:${fixture}/`);
    const card = page.getByRole('region', { name: section, exact: true });
    await card.getByText(title, { exact: true }).click();
    const control = () => card.getByRole('button', after ? { name: new RegExp(`^(more|less) — ${label}$`) } : undefined).first();
    const titleOpens = after ? (await control().getAttribute('aria-expanded')) === 'true' : await card.getByText('/synthetic/project').isVisible();
    assert.equal(titleOpens, !after);
    await page.screenshot({ path: `${dir}/component-${section}-title-${width}.png`, animations: 'disabled', scale: 'css' });
    if (!after) await control().click();
    await control().press('Enter');
    await card.getByText('/synthetic/project').waitFor();
    if (after) {
      assert.equal(await control().getAttribute('aria-expanded'), 'true');
      assert.equal(await control().evaluate(b => b === document.activeElement), true);
      await card.getByText('/synthetic/project').click();
      assert.equal(await control().getAttribute('aria-expanded'), 'true');
      const start = await card.getByText('/synthetic/project').evaluate(el => {
        const range = document.createRange();range.setStart(el.firstChild, 0);range.setEnd(el.firstChild, 3);
        const r = range.getBoundingClientRect();return { x:r.x,y:r.y,height:r.height };
      });
      await page.mouse.move(start.x + 1, start.y + start.height / 2);await page.mouse.down();
      await page.mouse.move(start.x + 45, start.y + start.height / 2, { steps:6 });await page.mouse.up();
      assert((await page.evaluate(() => window.getSelection()?.toString())).length >= 3);
      assert.equal(await control().getAttribute('aria-expanded'), 'true');
    }
    await control().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/component-${section}-open-${width}.png`, animations: 'disabled', scale: 'css' });
    const entry = { section, titleOpens };
    if (after) {
      entry.viewport = await page.evaluate(() => ({ width:innerWidth,scrollWidth:document.documentElement.scrollWidth }));
      assert.equal(entry.viewport.width, entry.viewport.scrollWidth);
      entry.placement = await control().evaluate(b => { const r = b.getBoundingClientRect(), p = b.closest('.flow-root').getBoundingClientRect();return { right:r.right,parentRight:p.right }; });
      assert(Math.abs(entry.placement.right - entry.placement.parentRight) <= 14);
      await control().press('Space');
      assert.equal(await control().getAttribute('aria-expanded'), 'false');
      assert.equal(await control().evaluate(b => b === document.activeElement), true);
    }
    observed.cases.push(entry);
  }
  const { worker, uuid } = JSON.parse(await readFile(`${run}/evidence/sdk-init-seed.json`, 'utf8'));
  await page.goto(`http://127.0.0.1:${daemon}/session/${worker}`);
  await page.getByText('Synthetic disclosure proof request', { exact: true }).waitFor();
  assert.equal(await page.getByText('synthetic-init-model', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Session Started', { exact: true }).count(), 0);
  observed.runtime = { surface: 'Actual isolated session', storedInitUuid: uuid, initVisible: false };
  observed.viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(observed.viewport.width, observed.viewport.scrollWidth);
  await page.screenshot({ path: `${dir}/runtime-hidden-${width}.png`, animations: 'disabled', scale: 'css' });
  await writeFile(`${dir}/observed-${width}.json`, JSON.stringify(observed, null, 2));
  return observed;
}
