import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run] = process.argv.slice(2);
assert(port && !['8399', '8499'].includes(port));
const base = `http://127.0.0.1:${port}`;
const rpc = (name, input = {}) => JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { encoding: 'utf8' })).reply;
assert(rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Fixture', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } }).success);
const model = rpc('rpc:models.list', { forceRefresh: true }).models.find(item => item.provider === 'anthropic');
assert(model);
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const receipts = [];
try {
  const pair = await browser.newContext();
  const made = rpc('device.pair.create', { kind: 'human' });
  assert.equal((await pair.request.post(`${base}/pair`, { headers: { origin: base }, data: { code: made.code, name: 'Synthetic thinking browser' } })).status(), 200);
  const storageState = await pair.storageState();
  await pair.close();
  for (const width of [390, 1280]) {
    assert(rpc('neo.preferences.set', { model: model.id, provider: 'anthropic', thinkingLevel: 'off' }).ok);
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, hasTouch: width === 390 });
    const page = await context.newPage();
    await page.goto(`${base}/neo`);
    const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
    await input.focus();
    await page.getByRole('button', { name: 'Model and thinking', exact: true }).click();
    const menu = page.getByRole('group', { name: 'Model and thinking settings', exact: true });
    const slider = menu.getByRole('slider', { name: 'Thinking', exact: true });
    await slider.waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Thinking"]').disabled);
    const box = await slider.boundingBox();
    await slider.click({ position: { x: box.width * 0.7, y: box.height / 2 } });
    await page.waitForFunction(() => document.querySelector('[aria-label="Thinking"]')?.disabled === false);
    const receipt = { width, visible: await menu.isVisible(), preferences: rpc('neo.snapshot').preferences, draft: await input.inputValue() };
    receipts.push(receipt);
    await page.screenshot({ path: `${run}/evidence/thinking-click-${width}.png` });
    assert(receipt.visible, 'the menu stays visible after a single thinking-level click');
    assert.notEqual(receipt.preferences.thinkingLevel, 'off');
    assert.equal(receipt.draft, '');
    await menu.getByRole('button', { name: 'Close model settings', exact: true }).click();
    await page.mouse.click(1, 1);
    await page.locator('.neo-composer-input.is-collapsed').waitFor();
    assert.equal(await menu.isVisible(), false);
    await context.close();
  }
  console.log('PASS: one thinking-level click saves without collapsing the empty composer at 390/1280');
} finally {
  writeFileSync(`${run}/evidence/thinking-click.json`, JSON.stringify(receipts, null, 2));
  await browser.close();
}
