import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: human-queue-web.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const evidence = join(run, 'evidence');
const base = `http://127.0.0.1:${port}`;
const code = execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic inbox browser' })], {
  encoding: 'utf8',
  env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') },
}).match(/"code":\s*"([^"]+)"/)?.[1];
assert(code, 'no pairing code');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const result = {};
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  const queue = page.locator('[data-human-queue]');
  const states = queue.getByRole('group', { name: 'State' });
  const open = async () => {
    await page.goto(`${base}/neo`);
    await page.waitForTimeout(500);
    const work = page.getByRole('button', { name: /your work/i }).first();
    if (await work.isVisible().catch(() => false)) await work.click();
    await queue.waitFor({ timeout: 15000 });
  };
  const labels = async (group) =>
    (await queue.getByRole('group', { name: group }).locator('button').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
  const regions = () => queue.getByRole('region').evaluateAll((all) => all.map((node) => node.getAttribute('aria-label')));
  await open();
  result.states = await labels('State');
  assert.deepEqual(result.states, ['Waiting on you 2', 'Held 1', 'In progress 2']);
  result.asks = await labels('Ask');
  assert.equal(result.asks[0], 'All 2');
  assert.deepEqual((await regions()).sort(), ['Synthetic tax filing', 'Synthetic trip plan']);
  assert.equal(await page.locator('[data-scene-group="attention"]').count(), 0, 'the old attention group gives way to the queue');
  await queue.getByText('Book the hotel by the station for three nights?').waitFor();
  await queue.getByText('Book the hotel', { exact: true }).waitFor();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(evidence, `queue-1280-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const hotel = queue.locator('[data-queue-card="hotel-card"]');
  await hotel.getByRole('button', { name: 'Hold' }).click();
  await states.getByRole('button', { name: 'Held 2' }).waitFor({ timeout: 10000 });
  await states.getByRole('button', { name: 'Held 2' }).click();
  await queue.getByText('The whole ask').waitFor();
  await queue.getByText('Keep the trip to one week?').waitFor();
  result.heldAfterHold = await queue.locator('[data-queue-card]').evaluateAll((all) => all.map((node) => node.getAttribute('data-queue-card')).sort());
  assert.deepEqual(result.heldAfterHold, ['hotel-card', 'trip-card']);
  await page.screenshot({ path: join(evidence, 'queue-1280-held.png') });
  await queue.locator('[data-queue-card="hotel-card"]').getByRole('button', { name: 'Take back' }).click();
  await states.getByRole('button', { name: 'Held 1' }).waitFor({ timeout: 10000 });
  await page.reload();
  await queue.waitFor();
  assert.deepEqual(await labels('State'), ['Waiting on you 2', 'Held 1', 'In progress 2'], 'take-back survives reload');
  await states.getByRole('button', { name: 'In progress 2' }).click();
  await queue.getByText('Call the garage').waitFor();
  result.progress = await queue.getByRole('region').allInnerTexts();
  await queue.getByRole('group', { name: 'Ask' }).getByRole('button', { name: /Synthetic car service/ }).click();
  assert.deepEqual(await regions(), ['Synthetic car service']);
  assert.deepEqual(await labels('State'), ['Waiting on you 0', 'Held 0', 'In progress 1'], 'state counts follow the ask choice');
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.waitForTimeout(500);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= 391), 'no sideways page scroll at phone width');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(evidence, `queue-390-${scheme}.png`) });
  }
  result.pageErrors = errors;
  assert.deepEqual(errors, []);
  result.passed = true;
} finally {
  writeFileSync(join(evidence, 'human-queue-web.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify(result));
