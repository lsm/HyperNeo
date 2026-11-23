export const projectActions = (page, name) =>
  page.getByRole('button', { name: `Project actions for ${name}`, exact: true });

export async function projectDelete(page, name) {
  const trigger = projectActions(page, name);
  await trigger.waitFor();
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  return page.getByRole('menuitem', { name: 'Delete this project', exact: true });
}
