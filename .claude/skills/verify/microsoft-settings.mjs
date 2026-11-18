import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const [port, pairCode, run] = process.argv.slice(2);
assert(port && port !== '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER, timeout: 20000 });
const observations = [];
const authorizations = [];
try {
  const pairing = await browser.newContext();
  const paired = await pairing.request.post(`http://127.0.0.1:${port}/pair`, { headers: { origin: `http://127.0.0.1:${port}` }, data: { code: pairCode, name: 'Synthetic settings browser' } });
  assert.equal(paired.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US', storageState });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (`${url.origin}${url.pathname}` === 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize') {
      const query = url.searchParams;
      authorizations.push(Object.fromEntries(query));
      assert.equal(query.get('code_challenge_method'), 'S256');
      assert.equal(query.get('prompt'), 'select_account');
      assert.equal(query.get('client_id'), 'synthetic-microsoft-client');
      const callback = new URL(query.get('redirect_uri'));
      assert.equal(callback.hostname, 'localhost');
      callback.search = new URLSearchParams({ code: `synthetic-code.${query.get('nonce')}`, state: query.get('state') }).toString();
      return route.fulfill({ contentType: 'text/html', body: `<h1>Fake Microsoft consent</h1><p>Synthetic account only</p><a href="${callback.href.replaceAll('&', '&amp;')}">Approve synthetic account</a>` });
    }
    assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port !== '8399', `external browser request refused: ${url.origin}`);
    return route.continue();
  });
  const page = await context.newPage();
  page.on('websocket', (socket) => assert.equal(new URL(socket.url()).port, port));
  page.setDefaultTimeout(10000);
  const shot = async (name) => {
    await page.screenshot({ path: `${run}/evidence/microsoft-settings-${name}.png`, fullPage: true, animations: 'disabled' });
    const text = await page.locator('main').count() ? await page.locator('main').innerText() : await page.locator('body').innerText();
    for (const secret of ['synthetic-access-token', 'synthetic-refresh-token', 'synthetic-code', pairCode]) assert(!text.includes(secret));
    observations.push({ name, text });
  };
  const consent = async (begin, capture = false) => {
    const popupEvent = page.waitForEvent('popup');
    await begin();
    const popup = await popupEvent;
    await popup.getByRole('heading', { name: 'Fake Microsoft consent' }).waitFor();
    await page.getByRole('status').filter({ hasText: 'Finish signing in on Microsoft.' }).waitFor();
    if (capture) {
      await page.reload();
      await page.getByRole('status').filter({ hasText: 'Finish signing in on Microsoft.' }).waitFor();
      await shot('pending');
      await popup.screenshot({ path: `${run}/evidence/microsoft-settings-consent.png` });
    }
    await popup.getByRole('link', { name: 'Approve synthetic account' }).click();
    await popup.getByText('Authorization received. Return to the app to finish connecting.').waitFor();
    await popup.close();
    await page.getByRole('status').waitFor({ state: 'hidden' });
  };
  await page.goto(`http://127.0.0.1:${port}/settings?tab=connections`);
  await page.getByRole('button', { name: 'Connect Google', exact: true }).waitFor();
  await page.getByText('No accounts connected.', { exact: true }).waitFor();
  await shot('empty');
  await page.getByRole('button', { name: 'Connect Google', exact: true }).click();
  await page.getByLabel('Desktop client ID', { exact: true }).fill('synthetic-google-client');
  await page.getByRole('button', { name: 'Connect Microsoft', exact: true }).click();
  assert.equal(await page.getByLabel('Application (client) ID', { exact: true }).inputValue(), '');
  await page.getByLabel('Application (client) ID', { exact: true }).fill('synthetic-microsoft-client');
  assert.equal(await page.getByLabel('Client secret (optional)', { exact: true }).count(), 0);
  await shot('setup');
  await consent(() => page.getByRole('button', { name: 'Continue to Microsoft', exact: true }).click(), true);
  await page.getByText('one@example.test', { exact: true }).waitFor();
  await page.getByText('Connected', { exact: true }).waitFor();
  await page.getByText('Read Outlook mail and manage drafts', { exact: true }).waitFor();
  await page.getByText('Read Outlook calendars', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  await shot('connected');
  await consent(() => page.getByRole('button', { name: 'Reconnect', exact: true }).click());
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByLabel('Application (client) ID', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 900 });
  await shot('mobile');
  const description = await page.getByText('Connect Google and Microsoft accounts for this instance.', { exact: true }).boundingBox();
  assert(description.height <= 40, 'the section description must not be squeezed by the connect buttons');
  const button = await page.getByRole('button', { name: 'Connect Microsoft', exact: true }).boundingBox();
  assert(button.x >= 0 && button.x + button.width <= 391);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.getByText('Disconnected', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('one@example.test', { exact: true }).waitFor();
  await page.getByText('Disconnected', { exact: true }).waitFor();
  await shot('disconnected');
  assert.equal(authorizations.length, 2);
  await context.close();
} catch (error) {
  const failures = [];
  for (const context of browser.contexts()) for (const page of context.pages()) {
    const text = await page.locator('body').innerText().catch(() => 'page closed');
    failures.push({ url: page.url(), text });
    await page.screenshot({ path: `${run}/evidence/microsoft-settings-failure.png`, fullPage: true }).catch(() => {});
  }
  writeFileSync(`${run}/evidence/microsoft-settings-failure.json`, JSON.stringify(failures, null, 2));
  throw error;
} finally { await browser.close(); }
writeFileSync(`${run}/evidence/microsoft-settings.json`, JSON.stringify({ observations, authorizations: authorizations.length, browserClosed: true }, null, 2));
