import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const [port, fakeOrigin, run, phase] = process.argv.slice(2);
assert(port && port !== '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER, timeout: 20000 });
const observations = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    assert(url.hostname === '127.0.0.1' && url.port !== '8399', `external browser request refused: ${url.origin}`);
    return route.continue();
  });
  const page = await context.newPage();
  page.on('websocket', (socket) => assert.equal(new URL(socket.url()).port, port));
  page.setDefaultTimeout(10000);
  const open = () => page.goto(`http://127.0.0.1:${port}/settings?tab=connections`);
  const shot = async (name) => {
    await page.screenshot({ path: `${run}/evidence/google-settings-${phase}-${name}.png`, fullPage: true, animations: 'disabled' });
    const text = await page.locator('main').count() ? await page.locator('main').innerText() : await page.locator('body').innerText();
    for (const secret of ['synthetic-secret', 'synthetic-access', 'synthetic-refresh']) assert(!text.includes(secret));
    observations.push({ name, text });
  };
  const consent = async (begin) => {
    const popupEvent = page.waitForEvent('popup');
    await begin();
    const popup = await popupEvent;
    await popup.getByRole('heading', { name: 'Fake Google consent' }).waitFor();
    await shot('pending');
    await popup.getByRole('link', { name: 'Approve synthetic account' }).click();
    await popup.getByText('Authorization received. Return to the app to finish connecting.').waitFor();
    await popup.close();
  };
  await open();
  await page.getByRole('button', { name: 'Connect Google', exact: true }).waitFor();
  if (phase === 'initial') {
    await page.getByText('No accounts connected.', { exact: true }).waitFor();
    await shot('empty');
    await page.getByRole('button', { name: 'Connect Google', exact: true }).click();
    await page.getByLabel('Desktop client ID', { exact: true }).fill('synthetic-client');
    await page.getByLabel('Client secret (optional)', { exact: true }).fill('synthetic-secret');
    await consent(() => page.getByRole('button', { name: 'Continue to Google', exact: true }).click());
    await page.getByText('one@example.test', { exact: true }).waitFor();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.getByText('Read Gmail', { exact: true }).waitFor();
    await page.getByText('Read calendar events', { exact: true }).waitFor();
    await shot('connected');
    await fetch(`${fakeOrigin}/fixture`, { method: 'POST', body: JSON.stringify({ subject: 'synthetic-other' }) });
    await consent(() => page.getByRole('button', { name: 'Reconnect', exact: true }).click());
    await page.getByRole('alert').filter({ hasText: 'account_mismatch' }).waitFor();
    assert.equal(await page.getByText('other@example.test', { exact: true }).count(), 0);
    await shot('mismatch');
    await fetch(`${fakeOrigin}/fixture`, { method: 'POST', body: JSON.stringify({ subject: 'synthetic-one' }) });
    await consent(() => page.getByRole('button', { name: 'Reconnect', exact: true }).click());
    await page.getByRole('status').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.setViewportSize({ width: 390, height: 900 });
    await shot('mobile');
    const row = page.getByText('one@example.test', { exact: true });
    const bounds = await row.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 391);
    assert(bounds.height <= 28, 'a short email must fit one line on the mobile account card');
  } else {
    await page.getByText('one@example.test', { exact: true }).waitFor();
    await page.getByText('Connected', { exact: true }).waitFor();
    await shot('restart');
    await consent(() => page.getByRole('button', { name: 'Reconnect', exact: true }).click());
    await page.getByRole('status').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByText('Disconnected', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('one@example.test', { exact: true }).waitFor();
    await page.getByText('Disconnected', { exact: true }).waitFor();
    await shot('disconnected');
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByLabel('Desktop client ID', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByLabel('Desktop client ID', { exact: true }).count(), 0);
  }
  await context.close();
} catch (error) {
  const failures = [];
  for (const context of browser.contexts()) for (const page of context.pages()) {
    const text = await page.locator('body').innerText().catch(() => 'page closed');
    failures.push({ url: page.url(), text });
    await page.screenshot({ path: `${run}/evidence/google-settings-${phase}-failure.png`, fullPage: true }).catch(() => {});
  }
  writeFileSync(`${run}/evidence/google-settings-${phase}-failure.json`, JSON.stringify(failures, null, 2));
  throw error;
} finally { await browser.close(); }
writeFileSync(`${run}/evidence/google-settings-${phase}.json`, JSON.stringify({ observations, browserClosed: true }, null, 2));
