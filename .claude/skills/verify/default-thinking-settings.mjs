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
const valueOf = async (page, wanted) => {
  await page.waitForFunction((value) => document.querySelector('select[aria-label="Default thinking"]')?.value === value, wanted, { timeout: 10000 });
};
const settings = () => rpc('rpc:state.global.snapshot').settings.settings;
assert(rpc('rpc:providers.create', {
  params: { providerId: 'anthropic', displayName: 'Anthropic fixture', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 },
  credentials: { apiKey: 'sk-devproxy-test-key' },
}).success);
const catalog = rpc('rpc:models.list', { forceRefresh: true }).models;
const model = catalog.find((entry) => entry.provider === 'anthropic' && entry.id.includes('sonnet'));
assert(model, JSON.stringify(catalog));
rpc('rpc:settings.global.update', { updates: { model: model.id, modelProvider: 'anthropic', thinkingLevel: 'think8k' } });
const neoThinkingBefore = rpc('neo.snapshot').preferences?.thinkingLevel ?? null;
const before = settings();
const evidence = { model, before, neoThinkingBefore, observations: [] };

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
try {
  const sent = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    if (String(frame.payload).includes('settings.global.update')) sent.push(String(frame.payload));
  }));
  await page.goto(`http://127.0.0.1:${port}/settings?tab=general`);
  await page.waitForFunction(() => document.body.innerText.includes('Default chat view'));
  evidence.generalHasThinking = (await page.locator('body').innerText()).includes('Thinking');
  assert.equal(evidence.generalHasThinking, false);
  await page.goto(`http://127.0.0.1:${port}/settings?tab=models`);
  const select = page.getByLabel('Default thinking', { exact: true });
  await select.waitFor();
  await page.waitForFunction((name) => document.body.innerText.includes(`${name} · `), model.display_name);
  await valueOf(page, 'think8k');
  assert.equal(await select.locator('option').count(), 7);
  assert(!(await page.locator('body').innerText()).includes('support for this model is unknown'));
  assert.deepEqual(sent, [], 'opening Settings must not write');
  assert.deepEqual(settings(), before);

  await select.selectOption('think24k');
  for (let i = 0; i < 40 && settings().thinkingLevel !== 'think24k'; i++) await page.waitForTimeout(100);
  const after = settings();
  assert.equal(after.thinkingLevel, 'think24k');
  assert.deepEqual({ ...after, thinkingLevel: before.thinkingLevel }, before, 'only thinkingLevel changed');
  evidence.writes = sent;
  evidence.after = after;
  evidence.neoThinkingAfter = rpc('neo.snapshot').preferences?.thinkingLevel ?? null;
  assert.equal(evidence.neoThinkingAfter, neoThinkingBefore);

  const created = rpc('rpc:session.create', { workspacePath: `${run}/home`, worktreeMode: 'direct' });
  const config = created.session.config;
  evidence.newSession = { model: config.model, provider: config.provider, thinkingLevel: config.thinkingLevel };
  assert.deepEqual(evidence.newSession, { model: model.id, provider: 'anthropic', thinkingLevel: 'think24k' });

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await select.waitFor();
    await valueOf(page, 'think24k');
    const box = await select.boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
    await page.screenshot({ path: `${run}/evidence/default-thinking-${width}.png`, fullPage: true, animations: 'disabled' });
    evidence.observations.push({ width, value: 'think24k', box });
  }
  writeFileSync(`${run}/evidence/default-thinking-settings.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, generalHasThinking: false, newSession: evidence.newSession, neoThinkingUnchanged: true, writesOnOpen: 0, screenshots: [1280, 390] }));
} catch (error) {
  await page.screenshot({ path: `${run}/evidence/default-thinking-failure.png`, fullPage: true });
  writeFileSync(`${run}/evidence/default-thinking-failure.txt`, await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
