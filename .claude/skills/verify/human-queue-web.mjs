import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: node human-queue-web.mjs <port> <run-dir>');
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  const queue = page.locator('[data-human-queue]');
  const open = async () => {
    await page.goto(`${base}/neo`);
    await page.waitForTimeout(500);
    const work = page.getByRole('button', { name: /your work/i }).first();
    if (await work.isVisible().catch(() => false)) await work.click();
    await queue.waitFor({ timeout: 15000 });
  };
  const row = (name) =>
    queue.getByRole('group', { name }).getByRole('button').allInnerTexts().then((all) => all.map((text) => text.replace(/\s+/g, ' ').trim()));
  const groups = () => queue.locator('section[aria-label]').evaluateAll((all) => all.map((group) => group.getAttribute('aria-label')));
  await open();
  result.states = await row('State');
  assert.deepEqual(result.states, ['Waiting on you 3', 'Held 0', 'In progress 1']);
  result.asks = await row('Ask');
  assert.deepEqual(result.asks, ['All 3', 'Release the synthetic build 1', 'Rename the synthetic app 2']);
  assert.deepEqual((await groups()).sort(), ['Release the synthetic build', 'Rename the synthetic app']);
  await queue.getByText('About: Ship the build').waitFor();
  await queue.getByText('About: Pick a name').first().waitFor();
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(evidence, `inbox-1280-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const release = queue.locator('section[aria-label="Release the synthetic build"]');
  await release.getByRole('button', { name: 'Hold' }).click();
  await page.waitForFunction(() => document.querySelector('[data-human-queue] [role="group"]')?.textContent?.includes('Held 1'));
  result.afterHold = await row('State');
  assert.deepEqual(result.afterHold, ['Waiting on you 2', 'Held 1', 'In progress 1']);
  await queue.getByRole('button', { name: 'Held 1' }).click();
  await release.getByText('Ship the synthetic build to testers today?').waitFor();
  await page.screenshot({ path: join(evidence, 'inbox-1280-held.png') });
  await release.getByRole('button', { name: 'Take back' }).click();
  await page.waitForFunction(() => document.querySelector('[data-human-queue] [role="group"]')?.textContent?.includes('Held 0'));
  result.afterTakeBack = await row('State');
  assert.deepEqual(result.afterTakeBack, ['Waiting on you 3', 'Held 0', 'In progress 1']);
  await queue.getByRole('button', { name: 'In progress 1' }).click();
  await queue.getByText('Write the release notes').waitFor();
  result.progressOwner = await release.locator('span.text-xs').innerText();
  await queue.getByRole('button', { name: 'Waiting on you 3' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  await page.waitForTimeout(800);
  const box = await queue.boundingBox();
  result.phoneQueue = box;
  assert(box && box.x >= 0 && box.x + box.width <= 391, 'the inbox stays inside the phone width');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= 391), 'no sideways page scroll');
  result.phoneRowTops = await queue.getByRole('group', { name: 'Ask' }).getByRole('button').evaluateAll((all) => all.map((button) => Math.round(button.getBoundingClientRect().top)));
  assert.equal(new Set(result.phoneRowTops).size, 1, 'the ask row stays on one line');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(evidence, `inbox-390-${scheme}.png`) });
  }
  result.pageErrors = errors;
  assert.deepEqual(errors, []);
  result.passed = true;
} finally {
  writeFileSync(join(evidence, 'human-queue-web.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify(result));
