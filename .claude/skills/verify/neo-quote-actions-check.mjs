import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyQuoteColours } from './markdown-quote-colours-proof.mjs';

export async function verifyQuoteActions(page, options) {
  const { run, phase, theme, touch = false } = options;
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch);
  const colours = await verifyQuoteColours(page, { ...options, phase: 'after' });
  const article = page.locator('[data-public-entry]').filter({ hasText: 'A short update' });
  const quote = article.locator('blockquote');
  const copy = quote.locator('button');
  const codeCopy = article.locator('.code-block-wrapper button');
  const footer = article.locator(':scope > .flex').last();
  const actions = [copy, footer.getByRole('button').nth(0), footer.getByRole('button').nth(1)];
  const settle = control => control.evaluate(async node => {
    await Promise.all(node.getAnimations().map(animation => animation.finished));
  });
  await page.waitForFunction(() => !document.querySelector('blockquote .text-success'));
  await settle(copy);
  const cancelReply = page.locator('[data-quote-bar]').getByRole('button');
  if (touch) await cancelReply.tap(); else await cancelReply.click();
  await page.locator('[data-quote-bar]').waitFor({ state: 'detached' });
  const measure = control => control.evaluate(node => {
    const button = node.getBoundingClientRect();
    const icon = node.querySelector('svg').getBoundingClientRect();
    const parent = node.parentElement.parentElement.getBoundingClientRect();
    return { box: [button.width, button.height, icon.width, icon.height],
      offset: [button.top - parent.top, parent.right - button.right] };
  });
  const quoteGeometry = await measure(copy), codeGeometry = await measure(codeCopy);
  await writeFile(join(run, 'evidence', `${phase}-${theme}-parity.json`), JSON.stringify({ quoteGeometry, codeGeometry }, null, 2));
  await article.screenshot({ path: join(run, 'evidence', `${phase}-${theme}-controls.png`), scale: 'css' });
  assert.deepEqual(quoteGeometry, codeGeometry, 'quote copy must match code copy box, icon and top-right offset');
  assert.equal(await quote.evaluate(node => node.style.paddingRight),
    await article.locator('pre').evaluate(node => node.style.paddingRight));
  assert.equal(await quote.evaluate(node => getComputedStyle(node).paddingRight),
    await article.locator('pre').evaluate(node => getComputedStyle(node).paddingRight));
  const geometry = [quoteGeometry];
  for (const control of actions.slice(1)) {
    const actual = await measure(control);
    assert.equal(actual.box.join(','), '44,44,20,20');
    geometry.push(actual);
  }
  const style = control => control.evaluate(node => {
    const value = getComputedStyle(node);
    return { colour: value.color, background: value.backgroundColor,
      outline: value.outline, outlineOffset: value.outlineOffset };
  });
  const normalBackground = await quote.evaluate(node => getComputedStyle(node).backgroundColor);
  if (!touch) {
    await copy.hover(); await settle(copy);
    const quoteHover = await style(copy);
    await article.screenshot({ path: join(run, 'evidence', `${phase}-${theme}-hover.png`), scale: 'css' });
    await codeCopy.hover(); await settle(codeCopy);
    assert.deepEqual(quoteHover, await style(codeCopy));
    for (const control of actions.slice(1)) {
      await control.hover(); await settle(control);
      const alpha = await control.evaluate(node => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = getComputedStyle(node).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3] / 255;
      });
      assert(Math.abs(alpha - .05) < .005);
    }
    assert.equal(await quote.evaluate(node => getComputedStyle(node).backgroundColor), normalBackground);
    await page.mouse.move(0, 0);
  }
  await copy.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert(await copy.evaluate(node => node.matches(':focus-visible')));
  await settle(copy);
  const focus = await style(copy);
  await article.screenshot({ path: join(run, 'evidence', `${phase}-${theme}-focus.png`), scale: 'css' });
  await codeCopy.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await settle(codeCopy); await settle(copy);
  assert.deepEqual(focus, await style(codeCopy));
  await copy.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('blockquote button')?.title === 'Copied!');
  assert.equal(await copy.textContent(), '');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'The release notes are ready for review. Please check the small changes before publishing.\n\nThank you for taking a look.');
  assert.deepEqual(await measure(copy), quoteGeometry);
  await article.screenshot({ path: join(run, 'evidence', `${phase}-${theme}-copied.png`), scale: 'css' });
  await page.waitForFunction(() => document.querySelector('blockquote button')?.title === 'Copy quote');
  if (touch) await codeCopy.tap(); else await codeCopy.click();
  await page.waitForFunction(() => document.querySelector('.code-block-wrapper button')?.title === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'A code sample.\n');
  await page.waitForFunction(() => !document.querySelector('.code-block-wrapper button')?.matches(':active'));
  await settle(codeCopy);
  assert.deepEqual(await measure(codeCopy), codeGeometry);
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
  const result = { ...colours, phase, touch, geometry, codeGeometry, focus, gutter, quoteBackgroundStable: true, actualClipboardExact: true };
  await writeFile(join(run, 'evidence', `${phase}-${theme}-actions.json`), JSON.stringify(result, null, 2));
  return result;
}
