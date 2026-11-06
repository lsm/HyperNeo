import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
function rpc(name, input = {}) {
  const result = JSON.parse(
    execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
      env: { ...process.env, VERIFY_PORT: port },
      encoding: 'utf8',
    })
  ).reply;
  assert(!result.error, JSON.stringify(result));
  return result;
}
const settings = () => rpc('rpc:state.global.snapshot').settings.settings;
assert(
  rpc('rpc:providers.create', {
    params: {
      providerId: 'anthropic',
      displayName: 'Anthropic fixture',
      kind: 'built_in',
      authType: 'api_key',
      isEnabled: true,
      isDefault: true,
      sortOrder: 0,
    },
    credentials: { apiKey: 'sk-devproxy-test-key' },
  }).success
);
const catalog = rpc('rpc:models.list', { forceRefresh: true }).models.filter(
  (entry) => entry.provider === 'anthropic'
);
assert(catalog.length >= 2, JSON.stringify(catalog));
const [first, second] = catalog;
const sourceKey = `anthropic/${first.id}`;
const otherKey = `anthropic/${second.id}`;
const entry = (model, thinkingLevel) => ({
  model: model.id,
  provider: 'anthropic',
  ...(thinkingLevel ? { thinkingLevel } : {}),
});
rpc('rpc:settings.global.update', {
  updates: {
    fallbackModels: [entry(first, 'think24k'), entry(second)],
    modelFallbackMap: {
      [sourceKey]: [entry(second, 'think16k'), entry(first)],
      [otherKey]: [entry(first)],
    },
  },
});
const before = settings();
const evidence = { before, observations: [] };

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
const row = (index) => page.getByLabel(`Fallback ${index} thinking`, { exact: true });
const saved = async (wanted) => {
  for (let i = 0; i < 40; i++) {
    if (JSON.stringify(settings().fallbackModels) === JSON.stringify(wanted)) return;
    await page.waitForTimeout(100);
  }
  assert.deepEqual(settings().fallbackModels, wanted);
};
try {
  const sent = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', (frame) => {
      if (String(frame.payload).includes('settings.global.update')) sent.push(String(frame.payload));
    })
  );
  const origin = `http://127.0.0.1:${port}`;
  const pairing = rpc('device.pair.create', { kind: 'human', name: 'Fallback thinking browser' });
  assert.equal(pairing.approval, 'approved');
  const paired = await page.request.post(`${origin}/pair`, {
    headers: { origin },
    data: { code: pairing.code, name: 'Fallback thinking browser' },
  });
  assert.equal(paired.status(), 200);
  await page.goto(`${origin}/settings?tab=models`);
  await row(1).waitFor();
  assert.equal(await row(1).inputValue(), 'think24k');
  assert.equal(await row(2).inputValue(), '');
  assert.deepEqual(sent, [], 'opening Settings must not write');
  assert.deepEqual(settings(), before);

  await row(2).selectOption('think8k');
  await saved([entry(first, 'think24k'), entry(second, 'think8k')]);
  await page.getByTitle('Move down').first().click();
  await saved([entry(second, 'think8k'), entry(first, 'think24k')]);
  await row(2).selectOption('');
  await saved([entry(second, 'think8k'), entry(first)]);
  const overrideRow = (index) => page.getByLabel(`Override fallback ${index} thinking`, { exact: true });
  const openOverride = async () => {
    await page.getByTitle('Edit').first().click();
    await overrideRow(1).waitFor();
  };
  const writes = sent.length;
  await openOverride();
  assert.equal(await overrideRow(1).inputValue(), 'think16k');
  assert.equal(await overrideRow(2).inputValue(), '');
  await overrideRow(1).selectOption('think8k');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(sent.length, writes, 'Cancel must not write');
  await openOverride();
  assert.equal(await overrideRow(1).inputValue(), 'think16k');
  await overrideRow(2).selectOption('think32k');
  const modal = overrideRow(1).locator('xpath=ancestor::div[contains(@class,"max-h-")]');
  await modal.getByTitle('Move down').first().click();
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  const wantedMap = {
    [sourceKey]: [entry(first, 'think32k'), entry(second, 'think16k')],
    [otherKey]: [entry(first)],
  };
  for (let i = 0; i < 40; i++) {
    if (JSON.stringify(settings().modelFallbackMap) === JSON.stringify(wantedMap)) break;
    await page.waitForTimeout(100);
  }
  assert.deepEqual(settings().modelFallbackMap, wantedMap);
  const after = settings();
  assert.deepEqual(
    { ...after, fallbackModels: before.fallbackModels, modelFallbackMap: before.modelFallbackMap },
    before
  );
  evidence.after = after;
  evidence.writes = sent.length;

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await row(1).waitFor();
    assert.equal(await row(1).inputValue(), 'think8k');
    assert.equal(await row(2).inputValue(), '');
    const box = await row(1).boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
    await openOverride();
    assert.equal(await overrideRow(1).inputValue(), 'think32k');
    const modalBox = await overrideRow(2).boundingBox();
    assert(
      modalBox && modalBox.x >= 0 && modalBox.x + modalBox.width <= width + 1,
      JSON.stringify(modalBox)
    );
    await page.screenshot({
      path: `${run}/evidence/override-thinking-${width}.png`,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await row(1).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${run}/evidence/fallback-thinking-${width}.png`,
      animations: 'disabled',
    });
    evidence.observations.push({ width, box });
  }
  writeFileSync(`${run}/evidence/fallback-thinking-settings.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, writes: sent.length, screenshots: [1280, 390] }));
} catch (error) {
  await page.screenshot({ path: `${run}/evidence/fallback-thinking-failure.png`, fullPage: true });
  writeFileSync(`${run}/evidence/fallback-thinking-failure.txt`, await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
