import { strict as assert } from 'node:assert';

export async function verifyWholeMessageCopy(page, fixture, { phase, touch = false, evidence }) {
  const entry = page.locator('[data-public-entry]').filter({ hasText: 'Copy fixture' });
  const settled = () => entry.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished));
  });
  await entry.getByRole('heading', { name: 'Copy fixture', exact: true }).waitFor();
  await settled();
  await page.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-initial.png`, scale: 'css' });
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const use = (control) => touch ? control.tap() : control.click();
  const footer = await entry.getByRole('button', { name: 'Copy Neo’s message', exact: true }).elementHandle();
  const expected = phase === 'before' ? fixture.full : fixture.whole;
  await use(footer);
  assert.equal(await clipboard(), expected);
  await use(entry.getByRole('button', { name: 'more', exact: true }));
  await entry.locator('[data-publication-details] pre code').waitFor();
  await use(footer);
  assert.equal(await clipboard(), expected);
  await use(entry.getByRole('button', { name: 'Copy details', exact: true }));
  assert.equal(await clipboard(), fixture.full);
  await use(entry.getByRole('button', { name: 'Copy quote', exact: true }));
  assert.equal(await clipboard(), 'A quoted passage.');
  const code = await entry.locator('[data-publication-details] pre code').textContent();
  assert.equal(code.trimEnd(), fixture.code);
  await use(entry.getByRole('button', { name: 'Copy code', exact: true }));
  assert.equal(await clipboard(), code);
  await settled();
  await page.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-expanded.png`, scale: 'css' });
  await use(entry.getByRole('button', { name: 'less', exact: true }));
  await entry.locator('[data-publication-details]').waitFor({ state: 'detached' });
  await use(footer);
  assert.equal(await clipboard(), expected);
  await entry.scrollIntoViewIfNeeded();
  if (touch) {
    const box = await entry.boundingBox(), cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 45, y: box.y + 75 }] });
      await page.waitForTimeout(600);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
  } else await entry.click({ button: 'right', position: { x: 35, y: 40 } });
  await use(page.getByRole('menuitem', { name: 'Copy', exact: true }));
  assert.equal(await clipboard(), expected);
  for (const [text, source] of [['Same source', 'Same **source**'], ['Verbatim source', 'Verbatim **source**']]) {
    const single = page.locator('[data-public-entry]').filter({ hasText: text });
    await use(single.getByRole('button', { name: 'Copy Neo’s message', exact: true }));
    assert.equal(await clipboard(), source);
  }
  const fit = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  assert(fit.scrollWidth <= fit.clientWidth + 1);
  await settled();
  await page.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-folded.png`, scale: 'css' });
  return { phase, touch, fit, footerCollapsed: true, footerExpanded: true, footerRefolded: true, contextCopy: true, detailsOnly: true, quoteOnly: true, codeOnly: true, equalSourceOnce: true, verbatimOnce: true };
}
