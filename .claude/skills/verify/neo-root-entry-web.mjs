import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const observed = { routes: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`${base}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Root entry browser');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  assert.equal(new URL(page.url()).hash, '');
  observed.pairing = (await context.cookies()).map(({ name, httpOnly, sameSite }) => ({
    name, httpOnly, sameSite,
  }));
  assert(observed.pairing.some(cookie => cookie.name === 'hyperneo_device' && cookie.httpOnly && cookie.sameSite === 'Strict'));
  await page.getByRole('link', { name: 'Open HyperNeo' }).click();
  await page.getByRole('textbox', { name: 'Message Neo', exact: true }).waitFor();
  assert.equal(page.url(), `${base}/`);
  observed.openAfterPairing = '/';
  for (const [name, path, neo] of [
    ['root', '/', true],
    ['root-query', '/?source=entry&x=a%20b#message', true],
    ['neo', '/neo?source=entry&x=a%20b#message', true],
    ['sessions', '/sessions?filter=idle#kept', false],
    ['settings', '/settings?tab=devices', false],
    ['session', '/session/00000000-0000-4000-8000-000000000001', false],
  ]) {
    await page.goto(`${base}${path}`);
    await page.waitForFunction(() => document.getElementById('root')?.childElementCount > 0);
    if (neo) await page.getByRole('textbox', { name: 'Message Neo', exact: true }).waitFor();
    if (name === 'sessions') await page.getByRole('button', { name: 'Start chat', exact: true }).waitFor();
    if (name === 'settings') await page.getByRole('heading', { name: 'Devices', exact: true }).waitFor();
    const title = await page.title();
    await page.screenshot({ path: `${run}/evidence/${name}.png`, animations: 'disabled' });
    observed.routes.push({ name, path: new URL(page.url()).pathname, search: new URL(page.url()).search, title });
    assert.equal(page.url(), `${base}${path}`, name);
    assert.equal(title.startsWith('Neo ·'), neo, `${name} entry title`);
    if (neo) await page.locator('.neo-shell').waitFor();
    else assert.equal(await page.locator('.neo-shell').count(), 0);
  }
  observed.verified = true;
} finally {
  writeFileSync(`${run}/evidence/observed.json`, JSON.stringify(observed, null, 2));
  await browser.close();
}
