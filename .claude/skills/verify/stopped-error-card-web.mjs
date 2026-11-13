import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, port = '9396', mode = 'after'] = process.argv.slice(2);
const run = realpathSync(directory);
assert.notEqual(port, '8399');
assert.notEqual(port, '8499');
const verify = fileURLToPath(new URL('.', import.meta.url));
const rpc = (...args) =>
  execFileSync('bun', [join(verify, 'rpc.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') },
  });
const sessionId = rpc(
  'rpc:session.create',
  JSON.stringify({ workspacePath: join(run, 'home'), worktreeMode: 'direct', title: 'Overloaded model' })
).match(/"sessionId":\s*"([^"]+)"/)?.[1];
assert(sessionId, 'no session');
const code = rpc('device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic error browser' })).match(
  /"code":\s*"([^"]+)"/
)?.[1];
assert(code, 'no pairing code');

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const observed = {};
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'en-US',
  });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  await page.goto(`${base}/session/${sessionId}`);
  const composer = page.getByRole('textbox').last();
  await composer.waitFor();
  const cards = page.locator('.bg-danger\\/10').filter({ hasText: 'API Error' });
  for (let turn = 1; turn <= 3; turn += 1) {
    await composer.fill(`Check why this request keeps failing (${turn}).`);
    await page.getByRole('button', { name: 'Send message' }).click();
    await cards.nth(turn - 1).waitFor({ timeout: 60000 });
  }
  await page.getByText(/(Query stopped|Stopped) after 3 failures/).first().waitFor({ timeout: 60000 });
  const settled = async () => {
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== 'running')
    );
    await page.waitForTimeout(500);
  };
  await settled();
  const card = page.locator('.bg-danger\\/10').filter({ hasText: 'API Error' }).last();
  const state = async () => ({
    banners: await page.getByTestId('error-banner').count(),
    bannerText: await page.getByTestId('error-banner').allInnerTexts(),
    apiErrorCards: await page.locator('.bg-danger\\/10').filter({ hasText: 'API Error' }).count(),
    stopNote: (await card.getByText('Stopped after 3 failures. Send a message to recover.').count()) > 0,
    details: await card.locator('details').count(),
    detailsOpen: await card.locator('details').evaluateAll((nodes) => nodes.some((node) => node.open)),
    rawVisible: await card.locator('pre').evaluateAll((nodes) => nodes.some((node) => node.checkVisibility())),
    pageOverflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
  });
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await settled();
    observed[scheme] = await state();
    await page.screenshot({ path: join(run, 'evidence', `stopped-error-${mode}-${scheme}.png`) });
  }
  if (mode === 'after') {
    await card.getByText('Technical details').click();
    observed.expanded = await state();
    await page.screenshot({ path: join(run, 'evidence', 'stopped-error-after-expanded.png') });
  }
  await context.close();
} finally {
  await browser.close();
  writeFileSync(join(run, 'evidence', `stopped-error-${mode}.json`), JSON.stringify(observed, null, 2));
}
console.log(JSON.stringify(observed, null, 2));
for (const scheme of ['dark', 'light']) {
  const seen = observed[scheme];
  assert.equal(seen.apiErrorCards >= 1, true);
  if (mode === 'before') {
    assert.equal(seen.banners, 1);
    assert.match(seen.bannerText[0], /^Query stopped after 3 failures/);
  } else {
    assert.deepEqual(
      { ...seen, apiErrorCards: undefined },
      {
        banners: 0,
        bannerText: [],
        apiErrorCards: undefined,
        stopNote: true,
        details: 1,
        detailsOpen: false,
        rawVisible: false,
        pageOverflow: false,
      }
    );
  }
}
if (mode === 'after') assert.equal(observed.expanded.rawVisible, true);
console.log(`PASS (${mode}): stopped query error shown ${mode === 'after' ? 'once, inside its API Error card' : 'as banner plus card'}`);
