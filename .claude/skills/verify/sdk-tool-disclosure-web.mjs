import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifySdkTools(page, { port, run, width, phase }) {
  assert(port !== '8399');
  const after = phase === 'after', dir = `${run}/evidence/${phase}`;
  await mkdir(dir, { recursive: true });
  const { worker } = JSON.parse(await readFile(`${run}/evidence/sdk-tool-seed.json`, 'utf8'));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/session/${worker}`);
  const read = page.getByText('synthetic.txt', { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  await read.waitFor();
  const observations = { width, phase, controls: [] };
  await read.getByText('Read', { exact: true }).click();
  if (after) assert.equal(await read.locator('pre').count(), 0);
  else { await read.locator('pre').waitFor(); await read.getByRole('button').first().click(); }
  observations.toolTitleOpens = !after;
  const readControl = () => read.getByRole('button', after ? { name: /^(more|less) — Read synthetic.txt$/ } : { name: /^Read/ });
  if (after) assert.equal(await readControl().getAttribute('aria-controls'), null);
  await shot(page, readControl(), `${dir}/tool-closed-${width}.png`);
  await readControl().press('Enter');
  await read.locator('pre').filter({ hasText: 'Synthetic tool detail.' }).waitFor();
  if (after) {
    assert.equal(await readControl().evaluate(b => b === document.activeElement), true);
    await read.locator('pre').click();
    assert.equal(await readControl().getAttribute('aria-expanded'), 'true');
    observations.controls.push(await metric(readControl()));
    observations.toolPanelRelationship = await readControl().evaluate(b => !!document.getElementById(b.getAttribute('aria-controls')));
    assert(observations.toolPanelRelationship);
    const start = await read.locator('pre').evaluate(el => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
      while ((node = walker.nextNode())) {
        const at = node.textContent.indexOf('Synthetic'); if (at < 0) continue;
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 3);
        const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height };
      }
      throw new Error('Synthetic result text missing');
    });
    await page.mouse.move(start.x + 1, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(start.x + 45, start.y + start.height / 2, { steps: 6 }); await page.mouse.up();
    observations.selectedText = await page.evaluate(() => window.getSelection()?.toString());
    assert.match(observations.selectedText, /^Syn/);
    assert.equal(await readControl().getAttribute('aria-expanded'), 'true');
  }
  await shot(page, readControl(), `${dir}/tool-open-${width}.png`);
  await readControl().press('Space');
  assert.equal(await read.locator('pre').count(), 0);
  if (after) assert.equal(await readControl().evaluate(b => b === document.activeElement), true);

  const subagent = page.getByText('Synthetic exploration', { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  await subagent.getByText('Synthetic exploration', { exact: true }).click();
  if (after) assert.equal(await subagent.getByText('Find synthetic evidence', { exact: true }).count(), 0);
  else { await subagent.getByText('Find synthetic evidence', { exact: true }).waitFor(); await subagent.getByRole('button', { name: /Explore.*Synthetic exploration/ }).click(); }
  observations.subagentTitleOpens = !after;
  const agentControl = () => subagent.getByRole('button', { name: after ? /^(more|less) — Explore Synthetic exploration$/ : /Explore.*Synthetic exploration/ });
  if (after) assert.equal(await agentControl().getAttribute('aria-controls'), null);
  await shot(page, agentControl(), `${dir}/subagent-closed-${width}.png`);
  await agentControl().press('Enter');
  await subagent.getByText('Find synthetic evidence', { exact: true }).waitFor();
  await subagent.locator('p').filter({ hasText: 'Short final paragraph.' }).waitFor();
  if (after) {
    assert.equal(await agentControl().evaluate(b => b === document.activeElement), true);
    await subagent.getByText('Find synthetic evidence', { exact: true }).click();
    assert.equal(await agentControl().getAttribute('aria-expanded'), 'true');
    observations.subagentPanelRelationship = await agentControl().evaluate(b => !!document.getElementById(b.getAttribute('aria-controls')));
    assert(observations.subagentPanelRelationship);
    const m = await metric(agentControl());
    m.lastLine = await subagent.locator('p').filter({ hasText: 'Short final paragraph.' }).evaluate(el => { const r = el.getBoundingClientRect(); return { bottom: r.bottom, right: r.right }; });
    assert(Math.abs(m.bottom - m.lastLine.bottom) <= 7);
    observations.controls.push(m);
  }
  const nested = subagent.getByText('nested-synthetic.txt', { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  const nestedControl = () => nested.getByRole('button', after ? { name: /^(more|less) — Read nested-synthetic.txt$/ } : { name: /^Read/ });
  await nestedControl().click();
  await nested.locator('pre').waitFor();
  if (after) {
    await nested.locator('pre').click();
    assert.equal(await nestedControl().getAttribute('aria-expanded'), 'true');
    observations.controls.push(await metric(nestedControl()));
  }
  await shot(page, nestedControl(), `${dir}/nested-tool-open-${width}.png`);
  const raw = subagent.getByText('Unknown message type: tool_progress', { exact: true }).locator('xpath=ancestor::details[1]');
  await raw.locator('summary').click();
  if (after) {
    assert.equal(await raw.getAttribute('open'), null);
    await raw.getByRole('button', { name: 'more — Unknown message type: tool_progress', exact: true }).press('Enter');
  }
  assert.equal(await raw.getAttribute('open'), '');
  const rawControl = after ? raw.getByRole('button', { name: 'less — Unknown message type: tool_progress', exact: true }) : raw.locator('summary');
  await shot(page, rawControl, `${dir}/raw-open-${width}.png`);
  if (after) {
    await raw.locator('pre').click(); assert.equal(await raw.getAttribute('open'), '');
    observations.controls.push(await metric(rawControl));
    await rawControl.press('Space'); assert.equal(await raw.getAttribute('open'), null);
  }
  await shot(page, agentControl(), `${dir}/subagent-open-${width}.png`);
  await agentControl().press('Space');
  assert.equal(await subagent.getByText('Find synthetic evidence', { exact: true }).count(), 0);
  if (after) {
    assert.equal(await agentControl().evaluate(b => b === document.activeElement), true);
    for (const m of observations.controls) assert(Math.abs(m.parentRight - m.right) <= 14);
  }
  observations.viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(observations.viewport.width, observations.viewport.scrollWidth);
  await writeFile(`${dir}/observed-${width}.json`, JSON.stringify(observations, null, 2));
  return observations;
}
async function shot(page, locator, path) {
  await locator.scrollIntoViewIfNeeded(); await page.evaluate(() => document.fonts.ready.then(() => {}));
  await page.screenshot({ path, scale: 'css', animations: 'disabled', timeout: 5000 });
}
async function metric(locator) {
  return locator.evaluate(b => { const r = b.getBoundingClientRect(), p = b.closest('.flow-root').getBoundingClientRect(); return { name: b.getAttribute('aria-label'), right: r.right, bottom: r.bottom, parentRight: p.right, parentBottom: p.bottom }; });
}
