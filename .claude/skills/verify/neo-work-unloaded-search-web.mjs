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
  const more = ui.getByRole('button', { name: 'Load more search results', exact: true });
  await more.waitFor({ state: 'visible' });
  assert.equal(await old.count(), 0);
  await writeFile(`${evidence}/${label}-first-page.png`, await tab.screenshot({ fullPage: false }));
  await more.click();
  await tab.getAXState({ emit: false });
  await old.waitFor({ state: 'visible', timeoutMs: 15000 });
  assert.equal(await old.getAttribute('data-ask-state'), 'done');
  assert.match(await old.innerText(), /网页修两处/);
  assert(await ui.locator('[data-scene-group="search"] [data-ask]').count() > 50);
  await old.getByRole('heading', { name: '网页修两处', exact: true }).click();
  await tab.getAXState({ emit: false });
  await writeFile(`${evidence}/${label}-search.png`, await tab.screenshot({ fullPage: false }));
  await old.getByRole('button', { name: 'All · 0', exact: true }).click();
  await tab.getAXState({ emit: false });
  assert(await ui.getByText('古老卡片正文', { exact: true }).isVisible());
  await writeFile(`${evidence}/${label}-open.png`, await tab.screenshot({ fullPage: false }));
  return { label, query: '网页修两处', unloadedBefore: true, foundCompleted: true, beyondFirstPage: true, openedOutcome: true };
}

export async function verifyShortQueries(tab, evidence, label) {
  const ui = tab.playwright;
  await ui.getByRole('button', { name: 'Close modal', exact: true }).click();
  await tab.getAXState({ emit: false });
  for (const query of ['to do', 'ok?']) {
    await ui.getByRole('searchbox', { name: 'Search work', exact: true }).fill(query);
    await tab.getAXState({ emit: false });
    await ui.getByText('Searching work…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await ui.getByText('Could not search work. Close and reopen search to retry.', { exact: true }).count(), 0);
    assert.equal(await ui.locator('[data-ask="ask-match"]').count(), 1);
  }
  await writeFile(`${evidence}/${label}-short-query.png`, await tab.screenshot({ fullPage: false }));
  return { label, queries: ['to do', 'ok?'], falseErrors: false, localMatchPreserved: true };
}

export async function verifyLocalSearchFailure(tab, evidence, label) {
  const ui = tab.playwright;
  await ui.getByRole('button', { name: 'Close modal', exact: true }).click();
  await tab.getAXState({ emit: false });
  await ui.getByRole('searchbox', { name: 'Search work', exact: true }).fill('needle');
  await tab.getAXState({ emit: false });
  await ui.getByText('Could not search work. Close and reopen search to retry.', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await ui.locator('[data-ask="ask-match"]').count(), 1);
  assert(await ui.getByRole('heading', { name: 'Needle ask', exact: true }).isVisible());
  await writeFile(`${evidence}/${label}-remote-failure.png`, await tab.screenshot({ fullPage: false }));
  return { label, localMatchPreserved: true, remoteFailureVisible: true };
}
