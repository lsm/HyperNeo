import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { listedAsks, revealAsk } from './queue-ask.mjs';

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
const result = {};
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'zh-CN' });
  await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  const queue = page.locator('[data-human-queue]:visible');
  const open = async () => {
    await page.goto(`${base}/neo`);
    const work = page.getByRole('button', { name: /your work|你的事/i }).first();
    await page.waitForTimeout(500);
    if (await work.isVisible().catch(() => false)) await work.click();
    await queue.waitFor({ timeout: 15000 });
    assert.equal(await page.locator('[data-topic-chips]').count(), 0);
  };
  const cards = () => listedAsks(page);
  const card = (id) => revealAsk(page, id);
  await open();
  assert.equal((await cards()).length, 11);
  const header = await (await card('screen-time')).locator('[data-ask-status] > span').first().innerText();
  assert.equal(header.trim(), '在做');
  const labels = [
    ['plain', '其他'],
    ['shop-a', 'Shop'],
    ['shop-b', 'Shop'],
    ['kids-lower', 'kids'],
    ['kids-upper', 'Kids'],
    ['protocol', 'OAP'],
  ];
  for (const [id, label] of labels) {
    const tag = (await card(id)).getByRole('button', { name: label, exact: true });
    assert.equal(await tag.isDisabled(), true);
  }
  result.readOnlyTags = labels;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(evidence, `topics-1280-${scheme}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: /search work|搜索/i }).first().click();
  const search = page.getByRole('searchbox');
  await search.fill('Synthetic protocol');
  const match = page.locator('article[data-ask="protocol"]');
  await match.waitFor();
  assert.equal(await match.getByRole('button', { name: 'OAP' }).isDisabled(), true);
  assert.equal(await search.inputValue(), 'Synthetic protocol');
  result.searchTagReadOnly = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-queue-state]')?.parentElement?.getBoundingClientRect();
    return row && row.width > 0 && row.left >= 0 && row.right <= innerWidth + 1;
  });
  const row = await queue.locator('[data-queue-state]').first().locator('..').boundingBox();
  result.phoneRow = row;
  await page.screenshot({ path: join(evidence, 'topics-390-check.png') });
  assert(row && row.x >= 0 && row.x + row.width <= 391, 'the state row stays inside the phone width');
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
