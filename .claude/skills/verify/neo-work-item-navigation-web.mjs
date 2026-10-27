import assert from 'node:assert/strict';

export async function verifyWorkItemNavigation(page, fixture, { phase, evidence, touch = false }) {
  const use = control => touch ? control.tap() : control.click();
  const reads = [];
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try { const value = JSON.parse(String(payload)); if (value.data?.name?.startsWith('neo.ask.')) reads.push(value.data); } catch {}
  }));
  const observed = [];
  for (const item of [
    { kind: 'todo', id: 'nav-done-25', title: 'Completed navigation card' },
    { kind: 'question', id: 'nav-answered', title: 'Stored navigation card', label: 'Saved answered reference' },
    { kind: 'question', id: 'nav-retired', title: 'Stored navigation card', label: 'Saved retired reference' },
  ]) {
    await page.goto(fixture.url);
    const control = item.kind === 'todo'
      ? page.locator('[data-reply-to="todo:nav-done-25"] button')
      : page.getByRole('button', { name: new RegExp(`I replied · View card.*${item.label}`) });
    await control.waitFor();
    await use(control);
    if (phase === 'before') {
      if (item.kind === 'question') await page.getByText('This card is no longer available.', { exact: true }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByRole('dialog', { name: item.title, exact: true }).count(), 0);
    } else {
      const dialog = page.getByRole('dialog', { name: item.title, exact: true });
      await dialog.waitFor();
      await page.waitForFunction(id => document.activeElement?.id === id, `neo-ref-${item.kind}-${item.id}`);
      assert(await dialog.evaluate(element => element.contains(document.activeElement)));
      const box = await dialog.boundingBox(), viewport = page.viewportSize();
      assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
      if (item.kind === 'todo') assert.equal(await dialog.locator('[data-todo-state="done"]').count(), 25);
    }
    await page.evaluate(async () => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished)));
    await page.screenshot({ path: `${evidence}/${touch ? 'mobile' : 'desktop'}-${item.id}-${phase}.png`, scale: 'css' });
    observed.push({ ...item, openedAtTarget: phase === 'after' });
  }
  if (phase === 'after') assert(reads.some(read => read.name === 'neo.ask.doneTodos' && read.input.offset === 20));
  return { touch, observed, reads };
}
