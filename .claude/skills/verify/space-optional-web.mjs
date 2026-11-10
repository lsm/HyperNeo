import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run, mode] = process.argv.slice(2);
assert(port && run && ['on', 'off'].includes(mode) && port !== '8399');
assert(process.env.PAIR_CODE, 'PAIR_CODE is required');
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const seen = {};
const settle = (page) => page.waitForTimeout(2500);
const pathOf = (page) => new URL(page.url()).pathname;
const visit = async (page, path) => {
  await page.goto(`${base}${path}`);
  await settle(page);
  const tabs = await page.getByRole('tab', { name: 'Spaces' }).count();
  seen[path] = { landedOn: pathOf(page), spacesTabs: tabs };
};

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Space check');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });

  for (const path of ['/', '/spaces', '/space/proof', '/space/proof/goals', '/sessions', '/settings'])
    await visit(page, path);
  await page.screenshot({ path: `${run}/evidence/space-${mode}-settings.png` });

  await page.goto(`${base}/sessions`);
  await settle(page);
  await page.keyboard.press('Meta+k');
  await settle(page);
  const input = page.getByTestId('command-palette-input');
  seen.paletteOpen = await input.count();
  if (seen.paletteOpen) {
    await input.fill('proof');
    await settle(page);
    seen.paletteHasSpace = await page.getByText('Proof', { exact: true }).count();
    await input.fill('go to spaces');
    await settle(page);
    seen.paletteHasSpaceCommand = await page.getByText('Go to spaces', { exact: true }).count();
    await page.keyboard.press('Escape');
  }

  if (mode === 'on') {
    await page.goto(`${base}/space/proof`);
    await settle(page);
    seen.detailShowsName = await page.getByText('Proof').count();
    await page.goto(`${base}/sessions`);
    await settle(page);
    await page.goBack();
    await settle(page);
    seen.backReturnsTo = pathOf(page);
    await page.screenshot({ path: `${run}/evidence/space-on-detail.png` });
  }
  seen.pageErrors = errors;
  writeFileSync(`${run}/evidence/space-${mode}-web.json`, JSON.stringify(seen, null, 2));
  console.log(JSON.stringify(seen, null, 1));
} finally {
  await browser.close();
}
