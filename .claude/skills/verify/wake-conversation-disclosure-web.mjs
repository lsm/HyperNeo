import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifyWakeConversation(page, { port, run, width, phase }) {
  const after = phase === 'after';
  const seed = JSON.parse(await readFile(`${run}/evidence/wake-conversation-seed.json`, 'utf8'));
  const dir = `${run}/evidence/${phase}`;
  await mkdir(dir, { recursive: true });
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/neo`);
  const wake = page.locator(`[data-wake="${seed.wake}"]`);
  await wake.waitFor();
  const message = page.locator('details[aria-label="Message from Neo to Synthetic worker"]');
  await message.waitFor();
  const pub = page.locator(`[data-message-ref="${seed.pub}"]`);
  const failed = page.locator(`[data-message-ref="${seed.failed}"]`);
  const toggle = row => row.getByRole('button', { name: /(?:more|less).*./ });
  const result = { phase, width, controls: [] };
  await wake.scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${dir}/collapsed-${width}.png`, scale: 'css' });
  await wake.getByText('Publish the guide', { exact: true }).click();
  result.wakeBodyOpens = await wake.getAttribute('open') !== null;
  if (after) { assert.equal(result.wakeBodyOpens, false); await toggle(wake).focus(); await page.keyboard.press('Enter'); }
  assert.equal(await wake.getByRole('link', { name: 'Which language?' }).isVisible(), true);
  if (after) { result.focusAfterOpen = await page.evaluate(() => document.activeElement?.getAttribute('aria-label')); assert.match(result.focusAfterOpen, /^less/); }
  const linkedPublication = seed.additions.find(a => a.kind === 'publication');
  const link = wake.getByRole('link', { name: linkedPublication.label, exact: true });
  assert.equal(await link.getAttribute('href'), `#${await wake.locator(`[data-message-ref="${linkedPublication.id}"]`).getAttribute('id')}`);
  if (after) {
    await wake.getByText('Synthetic wake finished.', { exact: true }).click();
    assert.equal(await toggle(wake).getAttribute('aria-expanded'), 'true');
  }
  await settle(page);
  await page.screenshot({ path: `${dir}/wake-expanded-${width}.png`, scale: 'css' });
  if (after) {
    result.controls.push(await controlBounds(toggle(wake)));
    await toggle(wake).press('Space');
    result.focusAfterClose = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    assert.match(result.focusAfterClose, /^more/);
  } else await wake.locator('summary').click();
  assert.equal(await wake.getAttribute('open'), null);
  await message.getByText('Synthetic session preview', { exact: true }).click();
  result.sessionBodyOpens = await message.getAttribute('open') !== null;
  if (after) { assert.equal(result.sessionBodyOpens, false); await toggle(message).click(); }
  const body = message.locator('p');
  assert.equal(await body.isVisible(), true);
  if (after) {
    await body.click();
    assert.equal(await toggle(message).getAttribute('aria-expanded'), 'true');
    const box = await body.evaluate(el => {const node=el.firstChild, at=node.textContent.indexOf('Synthetic session detail'); const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+9);const r=range.getBoundingClientRect();return {x:r.x,y:r.y,height:r.height};});
    await page.mouse.move(box.x+1,box.y+box.height/2); await page.mouse.down(); await page.mouse.move(box.x+85,box.y+box.height/2,{steps:10});await page.mouse.up();
    result.selectedText = await page.evaluate(() => window.getSelection()?.toString());
    assert.match(result.selectedText, /^Synthetic/);
    result.controls.push(await controlBounds(toggle(message)));
    result.sessionFinalLine = await toggle(message).evaluate(b => {
      const p=b.parentElement,node=p.firstChild,range=document.createRange();
      const end=node.textContent.trimEnd().length;
      range.setStart(node,end-1); range.setEnd(node,end);
      const last=range.getBoundingClientRect(), button=b.getBoundingClientRect(), parent=p.getBoundingClientRect();
      return {lastRight:last.right,lastBottom:last.bottom,buttonWidth:button.width,buttonBottom:button.bottom,available:parent.right-12-last.right};
    });
    if (result.sessionFinalLine.available >= result.sessionFinalLine.buttonWidth+12) assert(Math.abs(result.sessionFinalLine.buttonBottom-result.sessionFinalLine.lastBottom)<8);
  }
  await message.scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${dir}/session-expanded-${width}.png`, scale: 'css' });
  if (after) await toggle(message).click(); else await message.locator('summary').click();
  const historyToggle = () => pub.getByRole('button', { name: /Edited/ });
  if (after) {
    await pub.getByText('Edited', { exact: true }).click();
    assert.equal(await pub.getByRole('region', { name: 'Revision history' }).count(), 0);
  }
  await historyToggle().click();
  const original = pub.getByText('Synthetic original history detail', { exact: true });
  await original.waitFor();
  if (after) {
    await original.click();
    assert.equal(await historyToggle().getAttribute('aria-expanded'), 'true');
    result.controls.push(await controlBounds(historyToggle()));
  }
  await historyToggle().scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${dir}/history-expanded-${width}.png`, scale: 'css' });
  await historyToggle().click();
  const reasonToggle = () => failed.getByRole('button', { name: /Not delivered/ });
  if (after) {
    await failed.getByRole('img', { name: /Not delivered/ }).click();
    assert.equal(await failed.getByText('Not delivered: Neo never got this message.', { exact: true }).count(), 0);
  }
  await reasonToggle().click();
  await failed.getByText('Not delivered: Neo never got this message.', { exact: true }).waitFor();
  if (after) result.controls.push(await controlBounds(reasonToggle()));
  await failed.scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${dir}/reason-expanded-${width}.png`, scale: 'css' });
  await reasonToggle().click();
  if (after) {
    for (const c of result.controls) {assert.match(c.name,/less/); assert(Math.abs(c.parentRight-c.right)<18);}
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
