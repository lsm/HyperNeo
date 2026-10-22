import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifyLegacyCompact(page, { port, run, width, phase }) {
  assert.notEqual(String(port), '8399');
  const dir = `${run}/evidence/${phase}`;
  await mkdir(dir, { recursive: true });
  const { worker } = JSON.parse(await readFile(`${run}/evidence/sdk-tool-seed.json`, 'utf8'));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`http://127.0.0.1:${port}/session/${worker}`);
  const card = page.getByText('synthetic.txt', { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  await card.waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  await page.screenshot({ path: `${dir}/tool-closed-${width}.png`, animations: 'disabled' });
  const header = card.getByRole('button', { name: /^Read/ });
  const observed = { width, headerButtons: await header.count(), moreControls: await card.getByRole('button', { name: /^more/ }).count(), bounds: await card.boundingBox() };
  await writeFile(`${dir}/observed-${width}.json`, JSON.stringify(observed, null, 2));
  assert.equal(observed.headerButtons, 1, 'legacy tool title must be the compact disclosure button');
  assert.equal(observed.moreControls, 0, 'legacy tools must not use the floating more control');
  await header.press('Enter');
  await card.locator('pre').filter({ hasText: 'Synthetic tool detail.' }).waitFor();
  await page.screenshot({ path: `${dir}/tool-open-${width}.png`, animations: 'disabled' });
  await card.locator('pre').click();
  assert.equal(await card.locator('pre').count(), 1);
  await header.press('Space');
  assert.equal(await card.locator('pre').count(), 0);
  const subagent = page.getByRole('button', { name: /Explore.*Synthetic exploration/ });
  await subagent.press('Enter');
  await page.getByText('Find synthetic evidence', { exact: true }).waitFor();
  const nested = page.getByRole('button', { name: /^Read.*nested-synthetic/ });
  await nested.click();
  await page.getByText('Nested synthetic evidence.', { exact: false }).waitFor();
  await page.screenshot({ path: `${dir}/nested-open-${width}.png`, animations: 'disabled' });
  await subagent.press('Space');
  assert.equal(await page.getByText('Find synthetic evidence', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  return observed;
}
