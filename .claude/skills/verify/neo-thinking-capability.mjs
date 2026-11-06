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
const catalog = rpc('rpc:models.list', { forceRefresh: true }).models;
const [primary, fallback] = catalog.filter((entry) => entry.provider === 'anthropic');
assert(primary && fallback, JSON.stringify(catalog));
const preferences = {
  model: primary.id,
  provider: 'anthropic',
  thinkingLevel: 'think32k',
  fallbacks: [{ model: fallback.id, provider: 'anthropic', thinkingLevel: 'think24k' }],
};
const capabilities = {
  [primary.id]: { effortLevels: ['low', 'high'] },
  [fallback.id]: { thinkingModes: 'off' },
};
function withCapabilities(value) {
  if (Array.isArray(value)) return value.map(withCapabilities);
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, withCapabilities(item)])
  );
  return value.display_name ? { ...copy, ...capabilities[value.id] } : copy;
}
const set = rpc('neo.preferences.set', preferences);
assert(set.ok, JSON.stringify(set));
const saved = () => rpc('neo.snapshot').preferences;
const before = saved();
const evidence = { before, capabilities };

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
const row = (index) => page.getByLabel(`Neo model ${index} thinking`, { exact: true });
const options = (index) =>
  row(index)
    .locator('option')
    .evaluateAll((items) => items.map((item) => item.value));
try {
  const sent = [];
  await page.routeWebSocket(/\/ws/, (client) => {
    const server = client.connectToServer();
    client.onMessage((message) => {
      if (String(message).includes('neo.preferences.set')) sent.push(String(message));
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message !== 'string' || !message.includes('display_name')) {
        client.send(message);
        return;
      }
      client.send(JSON.stringify(withCapabilities(JSON.parse(message))));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const pairing = rpc('device.pair.create', { kind: 'human', name: 'Neo thinking browser' });
  assert.equal(pairing.approval, 'approved');
  const paired = await page.request.post(`${origin}/pair`, {
    headers: { origin },
    data: { code: pairing.code, name: 'Neo thinking browser' },
  });
  assert.equal(paired.status(), 200);
  await page.goto(`${origin}/settings?tab=neo-model`);
  await row(2).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('select[aria-label="Neo model 2 thinking"] option').length === 2
  );
  assert.deepEqual(await options(2), ['off', 'think24k']);
  assert.equal(await row(2).inputValue(), 'think24k');
  assert.deepEqual(await options(1), ['off', 'think8k', 'think24k', 'think32k']);
  assert.equal(await row(1).inputValue(), 'think32k');
  assert.equal(await page.getByText('Saved level is not supported by this model.').count(), 2);
  assert.deepEqual(sent, [], 'opening Settings must not write');
  assert.deepEqual(saved(), before);

  await page.getByRole('button', { name: 'Save Neo models', exact: true }).click();
  for (let i = 0; i < 40 && !sent.length; i++) await page.waitForTimeout(100);
  assert.equal(sent.length, 1);
  await page.waitForTimeout(300);
  assert.deepEqual(saved(), before, 'saving must keep the unsupported levels');

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await row(2).waitFor();
    assert.equal(await row(2).inputValue(), 'think24k');
    const box = await row(2).boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
    await row(2).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${run}/evidence/neo-thinking-${width}.png`, animations: 'disabled' });
  }
  writeFileSync(`${run}/evidence/neo-thinking-capability.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ok: true, screenshots: [1280, 390] }));
} catch (error) {
  await page.screenshot({ path: `${run}/evidence/neo-thinking-failure.png`, fullPage: true });
  writeFileSync(`${run}/evidence/neo-thinking-failure.txt`, await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
