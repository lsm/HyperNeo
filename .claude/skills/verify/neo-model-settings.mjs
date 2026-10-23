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
assert(rpc('rpc:providers.create', {
  params: { providerId: 'anthropic', displayName: 'Anthropic fixture', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 },
  credentials: { apiKey: 'sk-devproxy-test-key' },
}).success);
const catalog = rpc('rpc:models.list', { forceRefresh: true }).models;
const find = (family) => {
  const model = catalog.find((entry) => entry.provider === 'anthropic' && entry.id.includes(family));
  assert(model, JSON.stringify(catalog));
  return model;
};
const primary = find('opus'), first = find('sonnet'), second = find('haiku');
const thresholdText = `${Math.floor(primary.contextWindow * 0.7).toLocaleString('en-US')} of ${primary.contextWindow.toLocaleString('en-US')} tokens`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = { catalog, primary, first, second, thresholdText, observations: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  await page.goto(`http://127.0.0.1:${port}/settings?tab=neo-model`);
  const section = page.getByRole('region', { name: 'Neo models', exact: true });
  await section.getByRole('button', { name: 'Add Neo model', exact: true }).click();
  await page.getByRole('button', { name: primary.display_name, exact: true }).click();
  await section.getByLabel('Neo model 1 thinking', { exact: true }).selectOption('think24k');
  for (const model of [first, second]) {
    await section.getByRole('button', { name: 'Add Neo model', exact: true }).click();
    await page.getByRole('button', { name: model.display_name, exact: true }).click();
  }
  await section.getByLabel('Neo model 2 thinking', { exact: true }).selectOption('think8k');
  await section.getByLabel('Neo model 3 thinking', { exact: true }).selectOption('off');
  await section.getByTitle('Move up', { exact: true }).nth(2).click();
  await section.getByLabel('Auto-compact percentage', { exact: true }).fill('70');
  await section.getByText(thresholdText, { exact: false }).waitFor();
  await section.getByRole('button', { name: 'Save Neo models', exact: true }).click();
  const expected = { model: primary.id, provider: primary.provider, thinkingLevel: 'think24k', autoCompactPercent: 70, fallbacks: [
    { model: second.id, provider: second.provider, thinkingLevel: 'off' },
    { model: first.id, provider: first.provider, thinkingLevel: 'think8k' },
  ] };
  await page.getByText('Neo models saved', { exact: true }).waitFor();
  evidence.saved = rpc('neo.snapshot').preferences;
  for (const key of ['model', 'provider', 'thinkingLevel', 'fallbacks', 'autoCompactPercent']) assert.deepEqual(evidence.saved[key], expected[key]);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await section.getByLabel('Neo model 1 thinking', { exact: true }).waitFor();
    assert.equal(rpc('neo.snapshot').preferences.autoCompactPercent, 70);
    assert.equal(await section.getByLabel('Auto-compact percentage', { exact: true }).inputValue(), '70');
    await section.getByText(thresholdText, { exact: false }).waitFor();
    assert.equal(await section.getByLabel('Neo model 1 thinking', { exact: true }).inputValue(), 'think24k');
    assert.equal(await section.getByLabel('Neo model 2 thinking', { exact: true }).inputValue(), 'off');
    assert.equal(await section.getByLabel('Neo model 3 thinking', { exact: true }).inputValue(), 'think8k');
    assert((await section.getByTitle('Remove', { exact: true }).nth(1).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]').innerText()).includes(second.display_name));
    const providers = await section.getByText('Usable fallback providers:', { exact: false }).innerText();
    assert(providers.includes('Anthropic'));
    const overflow = await section.evaluate((element) => [...element.querySelectorAll('select,button')].filter((child) => { const box = child.getBoundingClientRect(); return box.x < 0 || box.right > innerWidth + 1; }).map((child) => child.outerHTML));
    assert.deepEqual(overflow, []);
    await page.screenshot({ path: `${run}/evidence/neo-model-settings-${width}.png`, fullPage: true, animations: 'disabled' });
    evidence.observations.push({ width, providers, persistedAfterReload: true, controlsFit: true });
  }
  await section.getByRole('button', { name: 'Disable Neo fallbacks', exact: true }).click();
  await section.getByRole('button', { name: 'Save Neo models', exact: true }).click();
  await page.getByText('Neo models saved', { exact: true }).waitFor();
  assert.deepEqual(rpc('neo.snapshot').preferences.fallbacks, []);
  await page.reload();
  await section.getByText('Neo fallbacks disabled.', { exact: true }).waitFor();
  evidence.disabledAfterReload = true;
  await section.getByLabel('Auto-compact percentage', { exact: true }).fill('90');
  await section.getByRole('button', { name: 'Save Neo models', exact: true }).click();
  await page.getByText('Neo models saved', { exact: true }).waitFor();
  assert.equal(rpc('neo.snapshot').preferences.autoCompactPercent, undefined);
  await page.reload();
  assert.equal(await section.getByLabel('Auto-compact percentage', { exact: true }).inputValue(), '90');
  await section.getByText(/Default.*unchanged/).waitFor();
  evidence.resetToDefault = true;
  await page.goto(`http://127.0.0.1:${port}/neo`);
  await page.getByRole('button', { name: 'Model and thinking', exact: true }).click();
  assert.equal(await page.getByRole('searchbox', { name: 'Search models' }).count(), 0);
  await page.getByRole('link', { name: 'Neo model settings', exact: true }).click();
  await page.waitForURL('**/settings?tab=neo-model');
  await section.getByLabel('Auto-compact percentage', { exact: true }).waitFor();
  evidence.popoverNavigatesToSettings = true;
  await page.goto(`http://127.0.0.1:${port}/settings?tab=models`);
  await page.getByRole('heading', { name: 'Models', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Neo models', exact: true }).count(), 0);
  evidence.ordinaryModelSettingsSeparate = true;
  console.log('PASS: actual Settings edit, thinking, provider list, order, persisted 70% reload, 90% reset, popover link and separate ordinary controls.');
} finally {
  writeFileSync(`${run}/evidence/neo-model-settings.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
