import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

export async function verifyUnloadedWorkSearch(tab, evidence, label) {
  const ui = tab.playwright;
  const sheet = ui.getByRole('button', { name: /^Your work/ });
  if (await sheet.count()) await sheet.click();
  await tab.getAXState({ emit: false });
  await ui.locator('[data-ask="ask-match"]').waitFor({ state: 'visible' });
  const old = ui.locator('[data-ask="old-unloaded"]');
  assert.equal(await old.count(), 0);
  await ui.getByRole('button', { name: 'Search work', exact: true }).click();
  await tab.getAXState({ emit: false });
  await ui.getByRole('searchbox', { name: 'Search work', exact: true }).fill('网页修两处');
  await tab.getAXState({ emit: false });
  await old.waitFor({ state: 'visible', timeoutMs: 15000 });
  assert.equal(await old.getAttribute('data-ask-state'), 'done');
  assert.match(await old.innerText(), /网页修两处/);
  await writeFile(`${evidence}/${label}-search.png`, await tab.screenshot({ fullPage: false }));
  await old.getByRole('button', { name: 'All · 0', exact: true }).click();
  await tab.getAXState({ emit: false });
  assert(await ui.getByText('古老卡片正文', { exact: true }).isVisible());
  await writeFile(`${evidence}/${label}-open.png`, await tab.screenshot({ fullPage: false }));
  return { label, query: '网页修两处', unloadedBefore: true, foundCompleted: true, openedOutcome: true };
}
