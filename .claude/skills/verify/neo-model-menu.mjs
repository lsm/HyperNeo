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
const start = find('sonnet'), picked = find('haiku');
assert.equal(rpc('neo.preferences.set', { model: start.id, provider: 'anthropic', thinkingLevel: 'off', autoCompactPercent: 70 }).ok, true);
const preference = () => rpc('neo.snapshot').preferences;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = { start, picked, seeded: preference(), observations: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  await page.goto(`http://127.0.0.1:${port}/neo`);
  const trigger = page.getByRole('button', { name: 'Model and thinking', exact: true });
  const menu = page.getByRole('group', { name: 'Model and thinking settings', exact: true });
  const option = (model) => menu.getByRole('button', { name: `${model.display_name} · Anthropic`, exact: true });
  await page.getByRole('textbox', { name: 'Message Neo', exact: true }).focus();
  await trigger.click();
  await option(picked).waitFor();
  assert.equal(await menu.getByRole('slider', { name: 'Thinking', exact: true }).count(), 1);
  assert.equal(await menu.locator('a').count(), 0);
  assert.equal(await page.getByText('Neo model settings', { exact: true }).count(), 0);
  assert.equal(await page.getByText(/Restart Neo/).count(), 0);
  evidence.menuListsModelsAndThinkingOnly = true;

  await menu.getByRole('slider', { name: 'Thinking', exact: true }).evaluate((slider) => {
    slider.value = '2';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await assertEventually(() => preference().thinkingLevel === 'think16k');
  evidence.afterThinking = preference();
  assert.deepEqual([evidence.afterThinking.model, evidence.afterThinking.autoCompactPercent], [start.id, 70]);
  await option(picked).click();
  await assertEventually(() => preference().model === picked.id);
  evidence.saved = preference();
  assert.deepEqual([evidence.saved.model, evidence.saved.provider, evidence.saved.thinkingLevel], [picked.id, 'anthropic', 'think16k']);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await page.getByRole('textbox', { name: 'Message Neo', exact: true }).focus();
    await trigger.click();
    await option(picked).waitFor();
    assert.equal(await option(picked).getAttribute('aria-pressed'), 'true');
    const label = await menu.getByTestId('thinking-slider-label').innerText();
    const box = await menu.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0, JSON.stringify(box));
    await page.screenshot({ path: `${run}/evidence/neo-model-menu-${width}.png`, animations: 'disabled' });
    evidence.observations.push({ width, pickedSelected: true, thinkingLabel: label, menuFits: true });
  }
  console.log('PASS: /neo menu lists models and thinking only, picks save Neo preferences keeping the auto-compact percent on a thinking change, selection survives reload at 1280/390 px.');
} finally {
  writeFileSync(`${run}/evidence/neo-model-menu.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}

async function assertEventually(check) {
  for (let i = 0; i < 40; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('condition never held');
}
