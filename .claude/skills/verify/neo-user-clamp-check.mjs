import assert from 'node:assert/strict';

export async function verifyMessageFade(page, fixture, { phase, evidence, touch = false }) {
  await page.goto(fixture.url);
  const use = control => touch ? control.tap() : control.click();
  const observations = [];
  for (const item of fixture.cases) {
    const article = page.locator(`[data-message-ref="${item.id}"]`);
    await article.locator('[data-clamped]').waitFor();
    await article.scrollIntoViewIfNeeded();
    await article.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished));
    });
    const cut = await article.locator('[data-clamped]').evaluate(element => ({
      height: element.clientHeight, fullHeight: element.scrollHeight,
      mask: getComputedStyle(element).maskImage,
      marker: element.parentElement.textContent.includes('⋯'),
    }));
    assert(cut.height < cut.fullHeight);
    if (phase === 'before') {
      assert.equal(cut.mask, 'none');
      await use(article.getByRole('button', { name: 'Show more', exact: true }));
      await use(article.getByRole('button', { name: 'Show less', exact: true }));
    } else {
      assert.notEqual(cut.mask, 'none');
      assert.equal(await article.getByText(/^(more|less)$/i, { exact: true }).count(), 0);
      if (item.name === 'fallback') assert(cut.marker);
      if (item.name === 'words' || item.name === 'cjk') assert(!cut.marker);
      const tapText = async () => {
        const body = article.locator('.neo-clamped-text');
        await body.evaluate(async element => { element.scrollIntoView({block:'start'}); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
        const box = await body.boundingBox();
        assert(box);
        const x = box.x + Math.min(150, box.width - 16), y = Math.max(80, box.y + 12);
        if(touch) await page.touchscreen.tap(x,y); else await page.mouse.click(x,y);
      };
      await tapText();
      assert.equal(await article.locator('[data-clamped]').count(), 0);
      await tapText();
      if(touch) assert.equal(await article.locator('[data-clamped]').count(),1);
      await article.locator('[data-clamped]').waitFor();
      const links = article.getByRole('link', { name: 'Safe link', exact: true });
      if (await links.count()) {
        await use(links.first());
        assert.equal(new URL(page.url()).hash, '#clamp-link');
        assert.equal(await article.locator('[data-clamped]').count(), 1);
      }
      const toggle = article.getByRole('button', { name: 'Show more', exact: true });
      await toggle.focus(); await page.keyboard.press('Enter');
      await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
      assert.equal(await article.locator('[data-clamped]').count(), 0);
      await page.keyboard.press('Space');
      await article.locator('[data-clamped]').waitFor();
    }
    await article.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-${item.name}.png`, scale: 'css' });
    observations.push({ name: item.name, ...cut });
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  return { touch, observations };
}
