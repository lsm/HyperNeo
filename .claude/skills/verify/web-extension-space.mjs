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
    env: { ...process.env, HYPERNEO_DATA_DIR: `${run}/data`, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!result.error, JSON.stringify(result));
  return result;
}
const space = rpc('rpc:space.create', { name: 'Synthetic Orbit', workspacePath: `${run}/home` });
const slug = space.slug ?? space.space?.slug;
assert(slug, JSON.stringify(space));
const evidence = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), slug, observations: {} };
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await page.context().addCookies([{ name: 'hyperneo_device', value: readFileSync(`${run}/data/local-rpc.credential`, 'utf8'), url: `http://127.0.0.1:${port}`, httpOnly: true, sameSite: 'Strict' }]);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  await page.goto(`http://127.0.0.1:${port}/spaces`);
  const intro = page.getByTestId('spaces-introduction');
  await intro.getByText('1 space', { exact: true }).waitFor();
  await page.screenshot({ path: `${run}/evidence/spaces-home.png`, animations: 'disabled' });
  evidence.observations.spacesHome = await intro.innerText();

  await intro.getByRole('button', { name: 'New Space', exact: true }).click();
  await page.getByText('Create Space', { exact: true }).first().waitFor();
  evidence.observations.createDialog = true;
  await page.keyboard.press('Escape');

  await page.keyboard.press('Meta+k');
  const palette = page.getByPlaceholder(/Search (chats|commands)/);
  await palette.waitFor();
  await palette.fill('Orbit');
  await page.getByText('Synthetic Orbit', { exact: true }).first().waitFor();
  evidence.observations.paletteFindsSpace = true;
  await page.keyboard.press('Enter');

  await page.waitForURL(new RegExp(`/space/${slug}`));
  await page.getByTestId('space-overview-dashboard').waitFor();
  await page.getByRole('navigation', { name: 'Space navigation' }).getByTestId('space-detail-goals').waitFor();
  await page.screenshot({ path: `${run}/evidence/space-overview.png`, animations: 'disabled' });
  evidence.observations.spaceIsland = page.url();

  assert.deepEqual(errors, []);
  evidence.pass = true;
  console.log(`PASS: Space home, create dialog, palette entry, space overview and detail panel render through the web extension registry (${slug})`);
} finally {
  writeFileSync(`${run}/evidence/web-extension-space.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
