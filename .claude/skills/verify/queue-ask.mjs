export async function revealAsk(page, askId) {
  const card = page.locator(`[data-ask="${askId}"]:visible`);
  await page.locator(`[data-ask="${askId}"]:visible, [data-human-queue]:visible`).first().waitFor();
  if (await card.count()) return card;
  const queue = page.locator('[data-human-queue]:visible');
  if (!(await queue.count())) return card;
  const section = queue.locator(`[data-queue-ask="${askId}"]`);
  for (const state of await queue.locator('[data-queue-state]').all()) {
    if (!(await section.count())) await state.click();
    if (!(await section.count())) continue;
    const open = section.locator('[data-queue-open]');
    if ((await open.getAttribute('aria-expanded')) !== 'true') await open.click();
    await card.first().waitFor();
    return card;
  }
  return card;
}
