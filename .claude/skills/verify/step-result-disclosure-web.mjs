import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

export async function verifyStepResults(page, { port, run, width, phase }) {
  const after = phase === 'after';
  const evidence = `${run}/evidence/${phase}`;
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/neo`);
  if (width < 640) await page.getByRole('button', { name: /Your work/ }).click();
  await page.getByRole('button', { name: 'Open Synthetic step 1', exact: true }).click();
  await page.getByText('Synthetic final reply.', { exact: true }).waitFor();
  const pane = page.locator('.neo-session-pane');
  const steps = () => pane.getByRole('button', { name: after ? /(?:more|less).*steps/ : /Worked/ });
  const summary = pane.getByText(/Worked 1s/);
  await summary.click();
  const bodyClickOpens = await pane.getByText('Synthetic thinking preview', { exact: true }).count();
  if (after) assert.equal(bodyClickOpens, 0); else await steps().click();
  await page.screenshot({ path: `${evidence}/neo-collapsed-${width}.png`, scale: 'css' });
  await steps().focus();
  await page.keyboard.press('Enter');
  const thinking = () => pane.getByRole('button', { name: after ? /(?:more|less).*Thinking/ : /Thinking.*Synthetic/ });
  const tool = () => pane.getByRole('button', { name: after ? /(?:more|less).*Read synthetic.txt/ : 'Read synthetic.txt' });
  await thinking().click();
  await tool().click();
  await pane.getByText('Short thinking ending.', { exact: false }).waitFor();
  const observations = { phase, width, bodyClickOpens, controls: [] };
  for (const button of [thinking(), tool(), steps()]) {
    const metric = await button.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const parent = b.parentElement.getBoundingClientRect();
      return { text: b.textContent, name: b.getAttribute('aria-label'), right: r.right, bottom: r.bottom, parentRight: parent.right, parentBottom: parent.bottom };
    });
    observations.controls.push(metric);
    if (after) {
      assert.match(metric.name, /less/);
      assert(Math.abs(metric.parentRight - metric.right) <= 18);
      assert(metric.parentBottom >= metric.bottom - 1);
    }
  }
  if (after) {
    const detail = pane.locator('span.italic').filter({ hasText: 'Short thinking ending.' });
    await detail.click();
    assert.equal(await thinking().getAttribute('aria-expanded'), 'true');
    const box = await detail.evaluate((el) => { const node = el.firstChild; const at = node.textContent.indexOf('Short'); const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 5); const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height }; });
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 75, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    observations.selectedText = await page.evaluate(() => window.getSelection()?.toString());
    assert.match(observations.selectedText, /^Short/);
    assert.equal(await thinking().getAttribute('aria-expanded'), 'true');
  }
  await tool().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/neo-expanded-${width}.png`, scale: 'css' });
  await steps().focus();
  await page.keyboard.press('Space');
  assert.equal(await pane.getByText('Synthetic thinking preview', { exact: true }).count(), 0);

  await page.goto(`http://127.0.0.1:${port}/session/40000000-0000-4000-8000-000000008097`);
  await page.getByRole('button', { name: /view: switch to/ }).waitFor();
  if (await page.getByRole('button', { name: 'Minimal view: switch to full', exact: true }).count()) await page.getByRole('button', { name: 'Minimal view: switch to full', exact: true }).click();
  if (await page.getByRole('button', { name: 'Full view: switch to compact', exact: true }).count()) await page.getByRole('button', { name: 'Full view: switch to compact', exact: true }).click();
  await page.getByRole('button', { name: 'Compact view: switch to minimal', exact: true }).click();
  const status = page.getByTestId('turn-status-line');
  await status.waitFor();
  const statusButton = () => status.getByRole('button');
  observations.statusCollapsed = await statusButton().textContent();
  await status.getByText(/Worked for/).click();
  if (after) assert.equal(await statusButton().getAttribute('aria-expanded'), 'false');
  await statusButton().click();
  if (after) assert.equal(await statusButton().getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: `${evidence}/sdk-status-${width}.png`, scale: 'css' });
  await page.getByRole('button', { name: 'Minimal view: switch to full', exact: true }).click();
  const resultSummary = page.getByText('12→3 tokens', { exact: true });
  await resultSummary.waitFor();
  const resultRoot = resultSummary.locator('xpath=ancestor::div[contains(@class,"rounded") and contains(@class,"mb-4")][1]');
  const resultButton = () => resultRoot.getByRole('button');
  await resultSummary.click();
  observations.sdkBodyClickOpens = await resultRoot.getByText('Synthetic result detail', { exact: true }).count();
  if (after) assert.equal(observations.sdkBodyClickOpens, 0); else await resultButton().click();
  await resultRoot.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/sdk-collapsed-${width}.png`, scale: 'css' });
  await resultButton().click();
  await resultRoot.getByText('Synthetic result detail', { exact: true }).waitFor();
  if (after) {
    await resultRoot.getByText('Synthetic result detail', { exact: true }).click();
    assert.equal(await resultButton().getAttribute('aria-expanded'), 'true');
    observations.resultControl = await resultButton().evaluate((b) => { const r = b.getBoundingClientRect(), p = b.parentElement.getBoundingClientRect(); return { name: b.getAttribute('aria-label'), right: r.right, bottom: r.bottom, parentRight: p.right, parentBottom: p.bottom }; });
    assert.match(observations.resultControl.name, /less/);
    assert(Math.abs(observations.resultControl.parentRight - observations.resultControl.right) <= 14);
  }
  await resultButton().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidence}/sdk-expanded-${width}.png`, scale: 'css' });
  await resultButton().focus();
  await page.keyboard.press('Space');
  assert.equal(await resultRoot.getByText('Synthetic result detail', { exact: true }).count(), 0);
  observations.viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(observations.viewport.scrollWidth <= width);
  await writeFile(`${evidence}/observed-${width}.json`, JSON.stringify(observations, null, 2));
  return observations;
}
