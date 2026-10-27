import assert from 'node:assert/strict';

export async function verifyDoneFold(page, fixture, { phase, evidence, touch = false }) {
  await page.goto(fixture.url);
  const use = control => touch ? control.tap() : control.click();
  if (touch) await use(page.getByRole('button', { name: 'Your work', exact: true }));
  const observed = [];
  for (const { askId, count } of fixture.cases) {
    const card = page.locator(`[data-ask="${askId}"]:visible`);
    await card.waitFor();
    const completed = () => card.locator('[data-ask-todo]').filter({ hasText: /Completed step/ });
    if (count > 3) await use(card.getByRole('button', { name: `${count} done — show more`, exact: true }));
    await completed().first().waitFor();
    while (await completed().count() < count) {
      const remaining = count - await completed().count();
      await use(card.getByRole('button', { name: `${remaining} done — show more`, exact: true }));
      await page.waitForFunction(({ id, remaining }) => document.querySelector(`[data-ask="${id}"]`)?.querySelectorAll('[data-ask-todo]').length > remaining, { id: askId, remaining: count - remaining + 1 });
    }
    assert.equal(await completed().count(), count);
    await card.scrollIntoViewIfNeeded();
    await card.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished));
    });
    const hide = card.getByRole('button', { name: 'Hide done todos', exact: true });
    await card.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-${count}-expanded.png`, scale: 'css' });
    if (phase === 'before') assert.equal(await hide.count(), 0);
    else {
      await use(hide);
      assert.equal(await completed().count(), 0);
      assert.equal(await card.locator('[data-ask-todo]').count(), 1);
      await use(card.getByRole('button', { name: `${count} done — show more`, exact: true }));
      assert.equal(await completed().count(), count);
      await use(hide);
      await card.screenshot({ path: `${evidence}/${phase}-${touch ? 'mobile' : 'desktop'}-${count}-folded.png`, scale: 'css' });
    }
    observed.push({ count, allPagesRead: true, foldedAndReopened: phase === 'after' });
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  return { touch, observed };
}
