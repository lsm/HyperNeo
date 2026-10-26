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
const rules = () => rpc('neo.snapshot').standingRules;
const seeded = Array.from({ length: 19 }, (_, i) => `Synthetic rule ${i + 1}.`);
assert.equal(rpc('neo.rule.save', { add: seeded }).ok, true);
assert.deepEqual(rules(), seeded);
const added = 'Open every synthetic PR from a fresh worktree.';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = { seeded, observations: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  await page.goto(`http://127.0.0.1:${port}/settings?tab=neo-model`);
  const section = page.getByRole('region', { name: 'Neo standing rules', exact: true });
  await section.getByText('19 of 20 rules', { exact: true }).waitFor();
  assert.equal(await section.getByRole('listitem').count(), 19);
  const box = section.getByLabel('New Neo rule', { exact: true });
  const add = section.getByRole('button', { name: 'Add rule', exact: true });
  const dialog = page.getByRole('alertdialog');

  await box.fill(added);
  await add.click();
  await dialog.getByText(added, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(rules(), seeded);
  evidence.cancelWritesNothing = true;

  await add.click();
  await dialog.getByText(added, { exact: true }).waitFor();
  await dialog.screenshot({ path: `${run}/evidence/neo-rules-confirm-add.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await section.getByText('20 of 20 rules', { exact: true }).waitFor();
  assert.deepEqual(rules(), [...seeded, added]);
  evidence.addAppendsOnlyTarget = true;

  await box.fill('One more synthetic rule.');
  await section.getByText('Neo keeps at most 20 rules; remove one first.', { exact: true }).waitFor();
  assert.equal(await add.isDisabled(), true);
  await box.fill('x'.repeat(501));
  await section.getByText('501 / 500 characters', { exact: true }).waitFor();
  assert.equal(await add.isDisabled(), true);
  await box.fill('');
  evidence.limitsBlockAdd = true;

  await section.getByRole('button', { name: 'Remove Neo rule 3', exact: true }).click();
  await dialog.getByText(seeded[2], { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await section.getByText('19 of 20 rules', { exact: true }).waitFor();
  const afterRemove = [...seeded.filter((rule) => rule !== seeded[2]), added];
  assert.deepEqual(rules(), afterRemove);
  evidence.removeDropsOnlyTarget = true;

  await section.getByRole('button', { name: 'Remove Neo rule 1', exact: true }).click();
  await dialog.getByText(seeded[0], { exact: true }).waitFor();
  assert.equal(rpc('neo.rule.save', { remove: [seeded[0]] }).ok, true);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await dialog.getByText(`"${seeded[0]}" is not a saved rule.`, { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const current = afterRemove.slice(1);
  assert.deepEqual(rules(), current);
  evidence.staleRemoveRefused = true;

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await section.getByText(`${current.length} of 20 rules`, { exact: true }).waitFor();
    const shown = await section.getByRole('listitem').allInnerTexts();
    assert.deepEqual(shown.map((row) => row.replace(/^\d+\.\s*/, '').replace(/\s*Remove$/, '').trim()), current);
    const overflow = await section.evaluate((element) => [...element.querySelectorAll('textarea,button,li')].filter((child) => { const rect = child.getBoundingClientRect(); return rect.x < 0 || rect.right > innerWidth + 1; }).map((child) => child.outerHTML.slice(0, 120)));
    assert.deepEqual(overflow, []);
    await section.screenshot({ path: `${run}/evidence/neo-rules-settings-${width}.png`, animations: 'disabled' });
    await box.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${run}/evidence/neo-rules-settings-${width}-add.png`, animations: 'disabled' });
    evidence.observations.push({ width, rows: shown.length, matchesSnapshot: true, controlsFit: true });
  }
  console.log('PASS: Settings > Neo rules list, confirm-before-write add/remove, cancel, 20/500 limits, stale remove refusal and reload at 1280/390 px.');
} finally {
  writeFileSync(`${run}/evidence/neo-rules-settings.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
