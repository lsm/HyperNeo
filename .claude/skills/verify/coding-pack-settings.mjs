import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
function rpc(name, input = {}) {
  const result = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!result.error, JSON.stringify(result));
  return result;
}
const global = { kind: 'global', key: '' };
const repo = { kind: 'repo', key: 'acme/app' };
const set = (scope, key, value) => assert.equal(rpc('pack.preferences.set', { pack: 'coding', scope, key, value }).ok, true);
const get = (scope, key) => rpc('pack.preferences.get', { pack: 'coding', scope, key }).preference;
const list = () => rpc('pack.preferences.list', { pack: 'coding' }).preferences;
set(global, 'mergePolicy', 'review_bot');
set(global, 'reviewBot', 'synthetic-bot');
set(repo, 'humanSignoff', []);
const seeded = list();
const evidence = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), seeded, observations: [] };
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  await page.goto(`http://127.0.0.1:${port}/settings`);
  await page.getByRole('button', { name: 'Coding pack', exact: true }).click();
  const section = page.getByRole('region', { name: 'Coding pack settings', exact: true });
  const state = (label) => section.getByRole('group', { name: label, exact: true }).locator('[data-state]');
  const merge = section.getByRole('combobox', { name: 'Merge policy', exact: true });
  const scopeTo = async (name) => {
    await section.getByRole('combobox', { name: 'Repository', exact: true }).fill(name);
    await section.getByText(`Editing: ${name || 'pack global'}`, { exact: true }).waitFor();
  };
  const states = async () => Object.fromEntries(await Promise.all(['Merge policy', 'Human sign-off paths or labels'].map(async (label) => [label, await state(label).innerText()])));

  await state('Merge policy').getByText('Saved for pack global').waitFor();
  assert.equal(await merge.inputValue(), 'review_bot');
  assert.equal(await section.getByRole('textbox', { name: 'Review bot', exact: true }).inputValue(), 'synthetic-bot');
  assert.equal(await state('Human sign-off paths or labels').innerText(), 'Unanswered');
  assert.equal(await section.getByRole('button', { name: /reset|delete|inherit/i }).count(), 0);
  evidence.globalView = await states();
  const watchBox = section.getByRole('textbox', { name: 'Watched repositories', exact: true });
  const saveWatches = section.getByRole('button', { name: 'Save watched repositories', exact: true });
  await page.screenshot({ path: `${run}/evidence/coding-watch-initial.png`, animations: 'disabled' });
  assert.equal(await watchBox.count(), 1, 'Coding settings must expose the instance watch list');
  assert.equal(await watchBox.inputValue(), '');
  assert.deepEqual(get(global, 'watchedRepos').value, []);
  assert.deepEqual(list(), seeded);
  evidence.emptyByDefault = true;


  await scopeTo('acme/app');
  assert.deepEqual(await states(), { 'Merge policy': 'Inherited from pack global', 'Human sign-off paths or labels': 'Saved for acme/app' });
  await section.getByText('No extra human sign-off paths or labels', { exact: true }).waitFor();
  await scopeTo('other/repo');
  assert.deepEqual(await states(), { 'Merge policy': 'Inherited from pack global', 'Human sign-off paths or labels': 'Unanswered' });
  assert.deepEqual(list(), seeded);
  evidence.openingWritesNothing = true;
  const signoffBox = section.getByRole('textbox', { name: 'Human sign-off paths or labels', exact: true });
  await signoffBox.fill('docs/**');
  await scopeTo('acme/app');
  assert.equal(await signoffBox.inputValue(), '');
  await scopeTo('other/repo');
  assert.equal(await signoffBox.inputValue(), '');
  assert.deepEqual(list(), seeded);
  evidence.draftDroppedOnScopeSwitch = true;

  await scopeTo('');
  await section.getByRole('textbox', { name: 'Review bot', exact: true }).fill('not a login!');
  await section.getByRole('group', { name: 'Review bot', exact: true }).getByRole('button', { name: 'Save' }).click();
  evidence.refusal = await section.getByRole('alert').innerText();
  assert.equal(evidence.refusal, 'Unknown setting, invalid scope or invalid value.');
  assert.equal(get(global, 'reviewBot').value, 'synthetic-bot');

  await section.getByRole('button', { name: 'Save sign-off paths', exact: true }).click();
  await state('Human sign-off paths or labels').getByText('Saved for pack global').waitFor();
  assert.deepEqual(get(global, 'humanSignoff'), { ...get(global, 'humanSignoff'), scope: global, value: [], setBy: 'human' });
  await scopeTo('other/repo');
  assert.equal(await state('Human sign-off paths or labels').innerText(), 'Inherited from pack global');
  evidence.explicitEmptyGlobal = true;

  await scopeTo('acme/app');
  await merge.selectOption('ci_only');
  await state('Merge policy').getByText('Saved for acme/app').waitFor();
  assert.equal(get(repo, 'mergePolicy').value, 'ci_only');
  assert.equal(get(global, 'mergePolicy').value, 'review_bot');
  assert.equal(await section.getByRole('group', { name: 'Review bot', exact: true }).count(), 0);
  evidence.repoSaveReadback = { repo: get(repo, 'mergePolicy'), global: get(global, 'mergePolicy') };

  await watchBox.fill('ACME/APP\nother/repo\nacme/app');
  await saveWatches.click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Watched repositories"]')?.value === 'acme/app\nother/repo');
  assert.deepEqual(get(global, 'watchedRepos').value, ['acme/app', 'other/repo']);
  assert.equal(get(global, 'watchedRepos').setBy, 'human');
  assert.equal(get(repo, 'mergePolicy').value, 'ci_only');
  evidence.watchListSavedAtInstanceScope = true;
  await watchBox.fill('not a repository');
  await saveWatches.click();
  await section.getByRole('alert').waitFor();
  assert.deepEqual(get(global, 'watchedRepos').value, ['acme/app', 'other/repo']);
  evidence.invalidWatchRefused = true;

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`http://127.0.0.1:${port}/settings?tab=coding-pack`);
    await scopeTo('acme/app');
    await state('Merge policy').getByText('Saved for acme/app').waitFor();
    assert.equal(await watchBox.inputValue(), 'acme/app\nother/repo');
    const overflow = await section.evaluate((element) => [...element.querySelectorAll('input,select,textarea,button')].filter((child) => { const rect = child.getBoundingClientRect(); return rect.x < 0 || rect.right > innerWidth + 1; }).map((child) => child.outerHTML.slice(0, 120)));
    assert.deepEqual(overflow, []);
    await page.screenshot({ path: `${run}/evidence/coding-pack-settings-${width}.png`, animations: 'disabled' });
    evidence.observations.push({ width, states: await states(), controlsFit: true });
  }
  execFileSync('sqlite3', [`${run}/data/daemon.db`, `
    INSERT INTO neo_concerns (id,title,summary,context,revision,created_at,updated_at)
      VALUES ('watch-forget','Synthetic watch project','','',1,1,1);
    INSERT INTO neo_project_workspaces (alias,project_id)
      VALUES ('repository:github.com/acme/app','watch-forget');
  `]);
  await watchBox.fill('acme/app\nother/repo\nnew/repo');
  assert.equal(rpc('neo.project.forget', { projectId: 'watch-forget' }).ok, true);
  assert.deepEqual(get(global, 'watchedRepos').value, ['other/repo']);
  await saveWatches.click();
  try {
    await section.getByRole('alert').waitFor({ timeout: 5000 });
  } finally {
    evidence.afterStaleSave = get(global, 'watchedRepos').value;
    await page.screenshot({ path: `${run}/evidence/coding-watch-stale-save.png`, animations: 'disabled' });
  }
  assert.equal(await section.getByRole('alert').innerText(), 'Watched repositories changed elsewhere. Review the refreshed list and save again.');
  assert.deepEqual(evidence.afterStaleSave, ['other/repo']);
  assert.equal(await watchBox.inputValue(), 'other/repo');
  evidence.staleSaveRefused = true;
  await watchBox.fill('');
  await saveWatches.click();
  await section.getByText('No repositories watched.', { exact: true }).waitFor();
  assert.deepEqual(get(global, 'watchedRepos').value, []);
  await page.reload();
  await state('Merge policy').getByText('Saved for pack global').waitFor();
  assert.equal(await watchBox.inputValue(), '');
  assert.deepEqual(get(global, 'watchedRepos').value, []);
  evidence.emptyWatchListSurvivesReload = true;
  evidence.final = list();
  console.log('PASS: Coding settings starts with no watches, saves/removes instance watches with readback and reload, refuses invalid values, preserves repository policies and fits at 1280/390 px.');
} finally {
  writeFileSync(`${run}/evidence/coding-pack-settings.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
