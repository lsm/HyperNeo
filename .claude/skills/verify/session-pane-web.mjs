// A work session is a tab from 720px and a full-screen pane below it.
export const sessionTitle = (page, name) =>
  page.locator('.neo-session-pane').getByRole('heading', name).or(page.getByRole('tab', name));

export async function leaveSession(page) {
  const back = page.getByRole('button', { name: 'Back to Neo', exact: true });
  if (await back.count()) return back.click();
  await page.locator('[role="tab"][aria-selected="true"] + button').click();
}
