import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifySdkText(page, { port, run, width, phase }) {
  assert(port !== '8399');
  const after = phase === 'after';
  const dir = `${run}/evidence/${phase}`;
  await mkdir(dir, { recursive: true });
  const seed = JSON.parse(await readFile(`${run}/evidence/sdk-text-seed.json`, 'utf8'));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/session/${seed.worker}`);
  await page.getByRole('button', { name: /view: switch to/ }).waitFor();
  if (await page.getByRole('button', { name: 'Full view: switch to compact' }).count())
    await page.getByRole('button', { name: 'Full view: switch to compact' }).click();
  if (await page.getByRole('button', { name: 'Minimal view: switch to full' }).count()) {
    await page.getByRole('button', { name: 'Minimal view: switch to full' }).click();
    await page.getByRole('button', { name: 'Full view: switch to compact' }).click();
  }
  const thinking = page.getByTestId('thinking-block').nth(1);
  await thinking.waitFor();
  await thinking.getByText('Thinking', { exact: true }).click();
  const bodyClickOpens = await thinking.locator('pre').count() > 0;
  if (after) assert.equal(bodyClickOpens, false);
  else await thinking.getByRole('button').first().click();
  await thinking.scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${dir}/thinking-compact-closed-${width}.png`, scale: 'css', animations: 'disabled', timeout: 5000 });
  await thinking.getByRole('button', after ? { name: 'more — Thinking', exact: true } : {}).first().press('Enter');
  await thinking.locator('pre').waitFor();
  if (after) {
    await thinking.locator('pre').click();
    assert.equal(await thinking.getByRole('button', { name: 'less — Thinking' }).getAttribute('aria-expanded'), 'true');
  }
  const observations = { width, phase, bodyClickOpens, controls: [] };
  await thinking.getByRole('button', after ? { name: 'less — Thinking' } : {}).last().scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${dir}/thinking-compact-open-${width}.png`, scale: 'css', animations: 'disabled', timeout: 5000 });
  if (after) await thinking.getByRole('button', { name: 'less — Thinking' }).press('Space');
  await page.getByRole('button', { name: 'Compact view: switch to minimal' }).click();
  await page.getByRole('button', { name: 'Minimal view: switch to full' }).click();
  await page.reload();
  await page.getByTestId('thinking-block').nth(1).getByRole('button', { name: after ? 'more — Thinking' : 'Show more', exact: true }).waitFor();
  for (const index of [1, 2]) {
    const block = page.getByTestId('thinking-block').nth(index);
    const more = block.getByRole('button', { name: after ? 'more — Thinking' : 'Show more', exact: true });
    await more.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: `${dir}/thinking-full-closed-${index}-${width}.png`, scale: 'css', animations: 'disabled', timeout: 5000 });
    await more.click();
    const less = block.getByRole('button', { name: after ? 'less — Thinking' : 'Show less', exact: true });
    await less.scrollIntoViewIfNeeded();
    if (after) {
      await block.locator('pre').click();
      assert.equal(await less.getAttribute('aria-expanded'), 'true');
      const metric = await metrics(less);
      const end = await ending(block.locator('pre'), index === 1 ? 'Short ending.' : 'Long final reasoning line.');
      metric.ending = end;
      assert(metric.bottom >= end.bottom - 5);
      if (index === 2 && width === 1280) assert(metric.bottom > end.bottom + 10);
      if (index === 1) {
        assert(Math.abs(metric.bottom - end.bottom) <= 5);
        await page.mouse.move(end.x + 1, end.y + end.height / 2);
        await page.mouse.down();
        await page.mouse.move(end.x + 34, end.y + end.height / 2, { steps: 6 });
        await page.mouse.up();
        observations.selectedText = await page.evaluate(() => window.getSelection()?.toString());
        assert.match(observations.selectedText, /^Sh/);
        assert.equal(await less.getAttribute('aria-expanded'), 'true');
      }
      observations.controls.push(metric);
    }
    await settle(page);
    await page.screenshot({ path: `${dir}/thinking-full-open-${index}-${width}.png`, scale: 'css', animations: 'disabled', timeout: 5000 });
    await less.click();
  }
  const synthetic = page.getByTestId('synthetic-card');
  const more = synthetic.getByRole('button', { name: after ? 'more — Synthetic' : 'Show more', exact: true });
  await more.scrollIntoViewIfNeeded(); await settle(page);
  await page.screenshot({ path: `${dir}/synthetic-closed-${width}.png`, scale: 'css', animations: 'disabled', timeout: 5000 });
  await more.press('Enter');
  const less = synthetic.getByRole('button', { name: after ? 'less — Synthetic' : 'Show less', exact: true });
  if (after) {
    await less.waitFor();
    const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('aria-label') }));
    await writeFile(`${dir}/synthetic-focus-${width}.json`, JSON.stringify(focus, null, 2));
    assert.equal(focus.name, 'less — Synthetic');
  }
  await less.scrollIntoViewIfNeeded();
  if (after) {
    await synthetic.locator('p').filter({ hasText: 'Short synthetic ending.' }).click();
    assert.equal(await less.getAttribute('aria-expanded'), 'true');
    const metric = await metrics(less);
    metric.ending = await ending(synthetic.locator('p').filter({ hasText: 'Short synthetic ending.' }), 'Short synthetic ending.');
    assert(Math.abs(metric.bottom - metric.ending.bottom) <= 5);
    observations.controls.push(metric);
  }
  await settle(page);
  await page.screenshot({ path: `${dir}/synthetic-open-${width}.png`, scale: 'css', animations: 'disabled', timeout: 5000 });
  await less.press('Space');
  if (after) {
    const collapsedFocus = await synthetic.getByRole('button', { name: 'more — Synthetic' }).evaluate(b => ({ focused: b === document.activeElement, name: b.getAttribute('aria-label') }));
    assert.equal(collapsedFocus.focused, true);
    await writeFile(`${dir}/synthetic-focus-collapsed-${width}.json`, JSON.stringify(collapsedFocus, null, 2));
    for (const metric of observations.controls) assert(Math.abs(metric.parentRight - metric.right) <= 14);
  }
  observations.viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(observations.viewport.width, observations.viewport.scrollWidth);
  await writeFile(`${dir}/observed-${width}.json`, JSON.stringify(observations, null, 2));
  return observations;
}
async function metrics(button) {
  return button.evaluate(b => { const r = b.getBoundingClientRect(), p = b.closest('.flow-root').getBoundingClientRect(); return { name: b.getAttribute('aria-label'), right: r.right, bottom: r.bottom, parentRight: p.right, parentBottom: p.bottom }; });
}
async function settle(page) {
  await page.evaluate(() => document.fonts.ready.then(() => {}));
}

async function ending(body, text) {
  return body.evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.textContent.lastIndexOf(text);
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + text.length);
      const rects = range.getClientRects(), r = rects[rects.length - 1];
      return { x: r.x, y: r.y, bottom: r.bottom, right: r.right, height: r.height };
    }
    throw new Error('Missing synthetic ending');
  }, text);
}
