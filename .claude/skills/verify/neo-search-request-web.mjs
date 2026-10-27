import assert from 'node:assert/strict';

export async function verifySearchRequest(page, fixture, { phase, evidence, touch = false }) {
  const use = control => touch ? control.tap() : control.click();
  await page.goto(fixture.url);
  if (touch) await use(page.getByRole('button', { name: /^Your work/ }));
  const work = page.locator('.neo-scene-list:visible');
  await use(work.getByRole('button', { name: 'Search work', exact: true }));
  const input = work.getByRole('searchbox', { name: 'Search work', exact: true });
  const observed = [];
  for (const query of ['requestsigil735', '请求']) {
    await input.fill(query);
    if (phase === 'before') {
      await work.getByText('No matching work', { exact: true }).waitFor();
      assert.equal(await work.locator('[data-scene-group="search"] [data-ask]').count(), 0);
    } else {
      await work.locator('[data-scene-group="search"] [data-ask="ask-match"]').waitFor();
      assert.equal(await work.locator('[data-scene-group="search"] [data-ask]').count(), 1);
    }
    await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
    await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-request-${query === '请求' ? 'cjk' : 'word'}-${phase}.png`, scale: 'css' });
    observed.push({ query, found: phase === 'after' });
  }
  return { touch, observed };
}
