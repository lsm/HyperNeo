import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyQuoteColours } from './markdown-quote-colours-proof.mjs';

export async function verifyQuoteActions(page, options) {
  const { run, phase, theme, touch = false } = options;
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch);
  const colours = await verifyQuoteColours(page, options);
  const article = page.locator('[data-public-entry]').filter({ hasText: 'A short update' });
  const quote = article.locator('blockquote');
  const copy = article.getByRole('button', { name: 'Copy quote', exact: true });
  const footer = article.locator(':scope > .flex').last();
  const actions = [copy, footer.getByRole('button').nth(0), footer.getByRole('button').nth(1)];
  await page.waitForFunction(() => !document.querySelector('.neo-quote-copy-button.text-success'));
  const geometry = [];
  for (const [index, control] of actions.entries()) {
    const box = await control.boundingBox();
    const icon = await control.locator('svg').boundingBox();
    const expected = phase === 'after'
      ? (index === 0 ? [64, touch ? 44 : 48, 20] : [44, 44, 20])
      : (index === 0 ? [60, 44, 16] : [touch ? 44 : 28, touch ? 44 : 28, 16]);
    assert.deepEqual([box.width, box.height, icon.width, icon.height], [...expected.slice(0, 2), expected[2], expected[2]]);
    geometry.push({ button: box, icon });
  }
  const quoteBackground = () => quote.evaluate(node => getComputedStyle(node).backgroundColor);
  const normalBackground = await quoteBackground();
  if (!touch) {
    for (const [index, control] of actions.entries()) {
      await control.hover();
      await control.evaluate(async node => {
        await Promise.all(node.getAnimations().map(animation => animation.finished));
      });
      const hover = await control.evaluate(node => {
        const style = getComputedStyle(node);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = style.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return { colour: style.color, background: [...context.getImageData(0, 0, 1, 1).data] };
      });
      if (phase === 'after') assert(Math.abs(hover.background[3] / 255 - .05) < .005);
      assert.equal(await quoteBackground(), normalBackground);
      geometry[index].hover = hover;
      await article.screenshot({ path: join(run, 'evidence', `${phase}-${theme}-hover-${index}.png`), scale: 'css' });
    }
    await page.mouse.move(0, 0);
  }
  await copy.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const focus = await copy.evaluate(node => {
    const style = getComputedStyle(node);
    return { visible: node.matches(':focus-visible'), colour: style.outlineColor, width: style.outlineWidth, offset: style.outlineOffset };
  });
  assert(focus.visible);
  if (phase === 'after') {
    assert.equal(focus.width, '2px');
    assert.equal(focus.offset, '2px');
  }
  await article.screenshot({ path: join(run, 'evidence', `${phase}-${theme}-focus.png`), scale: 'css' });
  await page.keyboard.press('Enter');
  await copy.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'The release notes are ready for review. Please check the small changes before publishing.\n\nThank you for taking a look.');
  assert.equal((await copy.boundingBox()).width, geometry[0].button.width);
  await article.screenshot({ path: join(run, 'evidence', `${phase}-${theme}-copied.png`), scale: 'css' });
  await page.waitForFunction(() => !document.querySelector('.neo-quote-copy-button.text-success'));
  if (touch) await footer.getByRole('button').first().tap();
  else await footer.getByRole('button').first().click();
  assert((await page.evaluate(() => navigator.clipboard.readText())).includes('## A short update'));
  const gutter = await quote.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node.querySelector('p'));
    return node.querySelector('button').getBoundingClientRect().left - range.getBoundingClientRect().right;
  });
  assert(gutter > 0);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const result = { ...colours, touch, geometry, focus, gutter, quoteBackgroundStable: true, actualClipboardExact: true };
  await writeFile(join(run, 'evidence', `${phase}-${theme}-actions.json`), JSON.stringify(result, null, 2));
  return result;
}
