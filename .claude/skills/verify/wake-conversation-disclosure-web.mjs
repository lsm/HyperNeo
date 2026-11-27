import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifyWakeConversation(page, { port, run, width, phase }) {
  const after = phase === 'after';
  const seed = JSON.parse(await readFile(`${run}/evidence/wake-conversation-seed.json`, 'utf8'));
  const dir = `${run}/evidence/${phase}`;
  await mkdir(dir, { recursive: true });
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/neo`);
  if (width < 1120) await page.getByRole('button', { name: /^Your work(?:,.*)?$/ }).click();
  const openScheduled = () => page.getByRole('button', { name: 'Scheduled', exact: true }).click();
  if (after) await openScheduled();
  const wake = page.locator(`#neo-preview-work-panel [data-wake="${seed.wake}"]`);
  await wake.waitFor();
  const failed = page.locator(`[data-message-ref="${seed.failed}"]`);
  const toggle = row => row.locator('summary');
  const result = { phase, width, controls: [] };
  await wake.scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${dir}/collapsed-${width}.png`, scale: 'css' });
  await wake.getByText('Publish the guide', { exact: true }).click();
  result.wakeBodyOpens = await wake.getAttribute('open') !== null;
  assert.equal(result.wakeBodyOpens, true);
  assert.equal(await wake.getByRole('link', { name: 'Which language?' }).isVisible(), true);

  const linkedPublication = seed.additions.find(a => a.kind === 'publication');
  const link = wake.getByRole('link', { name: linkedPublication.label, exact: true });
  assert.equal(await link.getAttribute('href'), `#${await page.locator(`[data-message-ref="${linkedPublication.id}"]`).getAttribute('id')}`);
  if (after) {
    await wake.getByText('Synthetic wake finished.', { exact: true }).click();
    assert.notEqual(await wake.getAttribute('open'), null);
  }
  await settle(page);
  await page.screenshot({ path: `${dir}/wake-expanded-${width}.png`, scale: 'css' });
  if (after) {
    await toggle(wake).press('Space');
    result.focusAfterClose = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    assert.match(result.focusAfterClose, /^Scheduled check-in:/);
  } else await wake.locator('summary').click();
  assert.equal(await wake.getAttribute('open'), null);
  if (width < 1120) await page.getByRole('button', { name: 'Close work list', exact: true }).click();
  const reasonToggle = () => failed.getByRole('button', { name: /Not delivered/ });
  if (after) {
    await failed.getByRole('img', { name: /Not delivered/ }).click();
    assert.equal(await failed.getByText('Not delivered: Neo never got this message.', { exact: true }).count(), 0);
  }
  await reasonToggle().click();
  await failed.getByText('Not delivered: Neo never got this message.', { exact: true }).waitFor();
  result.sessionRows = await page.locator('details[aria-label^="Message from "]').count();
  result.sessionTextShown = await page.getByText('Synthetic session preview').count();
  assert.equal(result.sessionRows, 0);
  assert.equal(result.sessionTextShown, 0);
  if (after) result.controls.push(await controlBounds(reasonToggle()));
  await failed.scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${dir}/reason-expanded-${width}.png`, scale: 'css' });
  await reasonToggle().click();
  if (after) {
    for (const c of result.controls) {assert.match(c.name,/less/); assert(Math.abs(c.parentRight-c.right)<18);}
    if (width < 1120) await page.getByRole('button', { name: /^Your work(?:,.*)?$/ }).click();
    await openScheduled();
    await toggle(wake).click();
    await wake.getByRole('link', { name: 'Which language?', exact: true }).click();
    const question = seed.additions.find(a => a.kind === 'question');
    await page.locator(`[data-ask-question="${question.id}"]`).waitFor();
    result.questionLink = question.id;
    if (width < 640) await page.getByRole('button', { name: 'Close work list', exact: true }).click();
  }
  result.viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(result.viewport.width, result.viewport.scrollWidth);
  await writeFile(`${dir}/observed-${width}.json`,JSON.stringify(result,null,2));
  return result;
}

async function controlBounds(button) {
  return button.evaluate(b => {const r=b.getBoundingClientRect(),p=b.parentElement.getBoundingClientRect();return {name:b.getAttribute('aria-label'),right:r.right,bottom:r.bottom,parentRight:p.right,parentBottom:p.bottom};});
}

async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
}
