import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: node card-topics-web.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const evidence = join(run, 'evidence');
const base = `http://127.0.0.1:${port}`;
const code = execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic topics browser' })], {
  encoding: 'utf8',
  env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') },
}).match(/"code":\s*"([^"]+)"/)?.[1];
assert(code, 'no pairing code');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const result = { views: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
  await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  const open = async () => {
    await page.goto(`${base}/neo`);
    const work = page.getByRole('button', { name: /your work|你的事/i }).first();
    await page.waitForTimeout(500);
    if (await work.isVisible().catch(() => false)) await work.click();
    await page.locator('[data-topic-chips]').waitFor({ timeout: 15000 });
  };
  const chips = () => page.locator('[data-topic-chips] button').allInnerTexts();
  const cards = () => page.locator('article[data-ask]').evaluateAll((all) => all.map((card) => card.getAttribute('data-ask')));
  await open();
  result.chips = (await chips()).map((text) => text.replace(/\s+/g, ' ').trim());
  assert.equal(result.chips[0], `全部 ${(await cards()).length}`);
  assert.deepEqual(result.chips.slice(1, 2), ['家长控制 2']);
  assert.equal(result.chips.at(-1), '其他 1');
  const header = await page.locator('article[data-ask="screen-time"] [data-ask-status]').innerText();
  assert.equal(header.trim(), '在做');
  assert.equal(await page.locator('article[data-ask] .rounded-full.px-2\\.5').count(), 0);
  assert.equal(await page.locator('article[data-ask="plain"] [data-topic-swatch]').count(), 0);
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(evidence, `topics-1280-${scheme}.png`), fullPage: true });
  }
  await page.locator('[data-topic-chips] button', { hasText: '家长控制' }).click();
  assert.deepEqual((await cards()).sort(), ['app-approvals', 'screen-time']);
  await page.reload();
  await page.locator('[data-topic-chips]').waitFor();
  assert.deepEqual((await cards()).sort(), ['app-approvals', 'screen-time'], 'the filter survives reload');
  await page.locator('[data-topic-chips] button', { hasText: '家长控制' }).click();
  assert((await cards()).length > 2, 'a second tap clears the filter');
  await page.locator('article[data-ask="protocol"]').getByRole('button', { name: 'OAP' }).click();
  assert.deepEqual(await cards(), ['protocol']);
  await page.screenshot({ path: join(evidence, 'topics-1280-filtered.png') });
  await page.locator('article[data-ask="protocol"]').getByRole('button', { name: 'OAP' }).click();
  assert((await cards()).length > 1, 'tapping the card topic again clears it');
  await page.getByRole('button', { name: /search work|搜索/i }).first().click();
  await page.getByRole('searchbox').fill('Synthetic protocol');
  await page.locator('article[data-ask="protocol"]').waitFor();
  assert.equal(await page.locator('[data-topic-chips]').count(), 0, 'chips hide while searching');
  await page.locator('article[data-ask="protocol"]').getByRole('button', { name: 'OAP' }).click();
  await page.locator('[data-topic-chips]').waitFor();
  assert.equal(await page.getByRole('searchbox').inputValue(), '', 'the topic tap clears the search');
  assert.deepEqual(await cards(), ['protocol'], 'and applies the filter');
  result.searchTopicTap = true;
  await page.locator('[data-topic-chips] button', { hasText: 'OAP' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.waitForTimeout(800);
  const row = await page.locator('[data-topic-chips]').boundingBox();
  result.phoneRow = row;
  await page.screenshot({ path: join(evidence, 'topics-390-check.png') });
  assert(row && row.x >= 0 && row.x + row.width <= 391, 'the chip row stays inside the phone width');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= 391), 'no sideways page scroll');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(evidence, `topics-390-${scheme}.png`) });
  }
  result.pageErrors = errors;
  assert.deepEqual(errors, []);
  result.passed = true;
} finally {
  writeFileSync(join(evidence, 'card-topics.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify(result));
