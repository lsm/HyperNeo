export async function queueSection(page, askId) {
  const queue = page.locator('[data-human-queue]:visible');
  if (!(await queue.count())) return null;
  const section = queue.locator(`[data-queue-ask="${askId}"]`).first();
  for (const state of await queue.locator('[data-queue-state]').all()) {
    if (await section.count()) return section;
    await state.click();
  }
  return (await section.count()) ? section : null;
}

export async function revealAsk(page, askId) {
  const card = page.locator(`[data-ask="${askId}"]:visible`);
  await page.locator(`[data-ask="${askId}"]:visible, [data-human-queue]:visible`).first().waitFor();
  if (await card.count()) return card;
  const section = await queueSection(page, askId);
  if (!section) return card;
  await card.first().waitFor();
  return card;
}

export async function listedAsks(scope) {
  const ids = new Set(await scope.locator('article[data-ask]:visible').evaluateAll((all) => all.map((card) => card.getAttribute('data-ask'))));
  const queue = scope.locator('[data-human-queue]:visible');
  if (await queue.count())
    for (const state of await queue.locator('[data-queue-state]').all()) {
      await state.click();
      for (const id of await queue.locator('[data-queue-ask]').evaluateAll((all) => all.map((group) => group.getAttribute('data-queue-ask')))) ids.add(id);
    }
  return [...ids];
}
