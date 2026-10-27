import assert from 'node:assert/strict';

export async function verifyReplyFold(page, fixture, { phase, evidence, touch = false }) {
  await page.goto(fixture.url);
  const entry = page.locator('[data-public-entry]').filter({ hasText: 'Copy fixture' });
  await entry.getByRole('heading', { name: 'Copy fixture', exact: true }).waitFor();
  const use = control => touch ? control.tap() : control.click();
  const observations = [];
  for (const state of ['collapsed', 'expanded', 'folded', 'reopened']) {
    const expanded = state === 'expanded' || state === 'reopened';
    if (expanded) await entry.locator('[data-publication-details] pre code').waitFor();
    const control = entry.getByRole('button', { name: expanded ? 'less' : 'more', exact: true });
    await control.scrollIntoViewIfNeeded();
    await entry.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished));
    });
    const geometry = await control.evaluate(button => {
      const content = button.closest('[data-publication-details]')?.querySelector('.neo-markdown')
        ?? button.closest('.neo-message-bubble').querySelector('.neo-markdown');
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      let bottom = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (button.contains(node) || !node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) bottom = Math.max(bottom, rect.bottom);
      }
      return { textBottom: bottom, controlTop: button.getBoundingClientRect().top };
    });
    assert.equal(await control.getAttribute('aria-expanded'), String(expanded));
    if (phase === 'before') {
      if (!expanded && !touch) assert(geometry.controlTop < geometry.textBottom);
    }
    else assert(geometry.controlTop >= geometry.textBottom, JSON.stringify({ state, geometry }));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-${state}.png`, scale: 'css' });
    observations.push({ state, ...geometry });
    await use(control);
  }
  return { touch, observations };
}
