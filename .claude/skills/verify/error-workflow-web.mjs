import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

export async function verifyErrorWorkflow(page, { run, port = 9396, width, phase }) {
  assert(['before', 'after'].includes(phase));
  const after = phase === 'after';
  const seed = JSON.parse(await readFile(`${run}/evidence/error-workflow-seed.json`, 'utf8'));
  const evidence = { phase, width, synthetic: true, source: 'real isolated daemon session.error and Space RPC' };
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/session/${seed.worker}`);
  await page.getByRole('button', { name: 'View Details', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.screenshot({ path: `${run}/evidence/${phase}-${width}-error-closed.png`, scale: 'css', animations: 'disabled' });
  const technical = dialog.getByText('Technical Details', { exact: true });
  await technical.click();
  const errorControl = after
    ? dialog.getByRole('button', { name: 'more — Technical Details', exact: true })
    : dialog.getByRole('button', { name: 'Technical Details', exact: true });
  evidence.errorTitleClickExpanded = await errorControl.getAttribute('aria-expanded');
  assert.equal(evidence.errorTitleClickExpanded, after ? 'false' : 'true');
  if (!after) await errorControl.click();
  await errorControl.press('Enter');
  const errorLess = after ? dialog.getByRole('button', { name: 'less — Technical Details', exact: true }) : errorControl;
  assert.equal(await errorLess.getAttribute('aria-expanded'), 'true');
  if (after) assert(await errorLess.evaluate(el => el === document.activeElement));
  const technicalBody = dialog.getByText('Synthetic technical detail. '.repeat(45).trim(), { exact: true });
  await page.waitForFunction(() => document.querySelector('[role=dialog] div[style*="height"]')?.style.height === 'auto');
  await technicalBody.click();
  assert.equal(await errorLess.getAttribute('aria-expanded'), 'true');
  const textRect = await technicalBody.boundingBox();
  await page.mouse.move(textRect.x + 2, textRect.y + 8);
  await page.mouse.down();
  await page.mouse.move(textRect.x + Math.min(textRect.width - 4, 180), textRect.y + 8, { steps: 12 });
  await page.mouse.up();
  evidence.errorSelection = await page.evaluate(() => window.getSelection()?.toString());
  assert(evidence.errorSelection?.length > 2);
  await errorLess.scrollIntoViewIfNeeded();
  evidence.errorControl = await errorLess.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { right: r.right, top: r.top, bottom: r.bottom, text: el.innerText, name: el.getAttribute('aria-label'), parentRight: el.parentElement.getBoundingClientRect().right };
  });
  if (after) {
    assert(Math.abs(evidence.errorControl.right - evidence.errorControl.parentRight) < 2);
    const stack = await dialog.locator('pre').last().boundingBox();
    assert(evidence.errorControl.top >= stack.y + stack.height - 2);
  }
  await page.screenshot({ path: `${run}/evidence/${phase}-${width}-error-open.png`, scale: 'css', animations: 'disabled' });
  await errorLess.press('Space');
  const errorMore = after ? dialog.getByRole('button', { name: 'more — Technical Details', exact: true }) : errorControl;
  assert.equal(await errorMore.getAttribute('aria-expanded'), 'false');
  if (after) assert(await errorMore.evaluate(el => el === document.activeElement));
  assert.equal(await dialog.getByRole('button', { name: 'Copy Error Report', exact: true }).count(), 1);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.goto(`http://127.0.0.1:${port}/space/${seed.spaceId}`);
  if (width < 768) await page.getByRole('button', { name: 'Open navigation menu', exact: true }).click();
  await page.getByRole('button', { name: 'Space settings', exact: true }).click();
  if (width < 768) await page.locator('button[aria-label="Close panel"]:visible').click();
  await page.getByRole('tab', { name: 'Runtime', exact: true }).click();
  const summary = page.getByTestId('autonomy-workflow-summary');
  await summary.waitFor();
  const count = summary.getByTestId('autonomy-workflow-summary-count');
  evidence.workflowCount = await count.innerText();
  assert.match(evidence.workflowCount, /Level 3: 5 of 7 workflows auto-close without review/);
  await count.click();
  const toggle = summary.getByTestId('autonomy-workflow-summary-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await page.screenshot({ path: `${run}/evidence/${phase}-${width}-workflow-closed.png`, scale: 'css', animations: 'disabled' });
  await toggle.press('Enter');
  const workflowLess = summary.getByTestId('autonomy-workflow-summary-toggle');
  assert.equal(await workflowLess.getAttribute('aria-expanded'), 'true');
  if (after) assert(await workflowLess.evaluate(el => el === document.activeElement));
  await summary.getByText('Synthetic blocked workflow', { exact: true }).click();
  const details = summary.getByTestId('autonomy-workflow-summary-details');
  assert.match(await details.innerText(), /Synthetic blocked workflow — requires level 5 or higher/);
  assert.equal(await workflowLess.getAttribute('aria-expanded'), 'true');
  const workflowText = await summary.getByText('Synthetic blocked workflow', { exact: true }).boundingBox();
  await page.mouse.move(workflowText.x + 2, workflowText.y + 6);
  await page.mouse.down();
  await page.mouse.move(workflowText.x + Math.min(workflowText.width - 2, 90), workflowText.y + 6, { steps: 8 });
  await page.mouse.up();
  evidence.workflowSelection = await page.evaluate(() => window.getSelection()?.toString());
  assert(evidence.workflowSelection?.length > 2);
  evidence.workflowControl = await workflowLess.evaluate(el => {
    const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
    return { right: r.right, top: r.top, parentRight: p.right, text: el.innerText, name: el.getAttribute('aria-label') };
  });
  if (after) {
    assert(Math.abs(evidence.workflowControl.right - evidence.workflowControl.parentRight) < 2);
    const detailRect = await details.boundingBox();
    assert(evidence.workflowControl.top >= detailRect.y + detailRect.height - 2);
  }
  await page.screenshot({ path: `${run}/evidence/${phase}-${width}-workflow-open.png`, scale: 'css', animations: 'disabled' });
  await workflowLess.press('Space');
  assert.equal(await summary.getByTestId('autonomy-workflow-summary-details').count(), 0);
  if (after) assert(await summary.getByTestId('autonomy-workflow-summary-toggle').evaluate(el => el === document.activeElement));
  evidence.document = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(evidence.document.scrollWidth <= width);
  await writeFile(`${run}/evidence/${phase}-${width}.json`, JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
