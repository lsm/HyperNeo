import assert from 'node:assert/strict';

export async function verifyFadeWordSelection(page, fixture, { phase, evidence, touch = false }) {
  await page.goto(fixture.url);
  const words = fixture.cases.find(item => item.name === 'words');
  const article = page.locator(`[data-message-ref="${words.id}"]`);
  await article.getByRole('button', { name: 'Show more', exact: true }).focus();
  await page.keyboard.press('Enter');
  await article.locator('.neo-clamped-text').evaluate(element => element.scrollIntoView({ block: 'start' }));
  const point = await article.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let matching = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent.indexOf('wrapping');
      if (index < 0 || matching++ !== 1) continue;
      const range = document.createRange();
      range.setStart(node, index); range.setEnd(node, index + 'wrapping'.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
  });
  assert(point && point.y > 60 && point.y < page.viewportSize().height);
  await page.mouse.dblclick(point.x, point.y, { delay: 80 });
  await page.waitForTimeout(600);
  const folded = await article.locator('[data-clamped]').count() === 1;
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  assert.equal(folded, phase === 'before');
  if (phase === 'after') assert.equal(selected, 'wrapping');
  await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-word-selection-${phase}.png`, scale: 'css' });
  return { touch, folded, selected, gesture: 'mouse double-click in each responsive layout' };
}
