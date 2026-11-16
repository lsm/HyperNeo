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
  const open = section.locator('[data-queue-open]');
  await open.waitFor();
  if ((await open.getAttribute('aria-expanded')) !== 'true') await open.click();
  await card.first().waitFor();
  return card;
}
