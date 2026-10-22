import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function verifyToolScroll(page, { port, run, width, phase }) {
  assert(Number(port) !== 8399);
  const dir = `${run}/evidence/scroll-${phase}`;
  await mkdir(dir, { recursive: true });
  const { worker } = JSON.parse(await readFile(`${run}/evidence/sdk-tool-seed.json`, 'utf8'));
  await page.setViewportSize({ width, height: 1000 });
  const observed = { width, phase, cases: [] };
  for (const [title, name, content] of [
    ['synthetic-long-output', 'Bash synthetic-long-output', 'Synthetic long result line.'],
    ['Synthetic exploration', 'Explore Synthetic exploration', 'Short final paragraph.'],
  ]) {
    await page.goto(`http://127.0.0.1:${port}/session/${worker}`);
    const card = page.getByText(title, { exact: true }).first().locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
    const more = card.getByRole('button', { name: `more — ${name}`, exact: true });
    await more.waitFor();
    await more.click();
    await card.locator('pre,p').filter({ hasText: content }).first().waitFor();
    await card.getByRole('button', { name: `less — ${name}`, exact: true }).click();
    await more.scrollIntoViewIfNeeded();
    await more.hover();
    await page.mouse.wheel(0, -250);
    await more.scrollIntoViewIfNeeded();
    await more.focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await card.evaluate(el => el.getBoundingClientRect().top);
    await page.keyboard.press('Enter');
    await card.locator('pre,p').filter({ hasText: content }).first().waitFor();
    const less = card.getByRole('button', { name: `less — ${name}`, exact: true });
    await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, `less — ${name}`);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await card.evaluate(el => el.getBoundingClientRect().top);
    const footer = await less.boundingBox();
    const result = { name, before, after, delta: after - before, footer, focused: await less.evaluate(el => el === document.activeElement) };
    observed.cases.push(result);
    await page.screenshot({ path: `${dir}/${title.replaceAll('.', '-')}-${width}.png`, animations: 'disabled', scale: 'css' });
  }
  await writeFile(`${dir}/observed-${width}.json`, JSON.stringify(observed, null, 2));
  for (const result of observed.cases) {
    assert(Math.abs(result.delta) <= 2, `${result.name} moved ${result.delta}px on expansion`);
    assert(result.focused);
    assert(result.footer.y > 1000, `${result.name} should keep focus on its offscreen footer`);
  }
  return observed;
}
