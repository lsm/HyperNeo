import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const [port, evidence] = process.argv.slice(2);
const db = process.env.VERIFY_DB;
assert(port && port !== '8399' && evidence && process.env.PAIR_CODE && db);
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const grantFilter = "provider_id LIKE 'hyperneo.connection.%.mcp.%'";
const grants = () =>
  Number(
    execFileSync('sqlite3', [db, `SELECT count(*) FROM provider_credentials WHERE ${grantFilter}`])
      .toString()
      .trim()
  );
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER || undefined,
});
const result = { steps: [] };
let page;
try {
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, {
    headers: { origin: base },
    data: { code: process.env.PAIR_CODE, name: 'Synthetic browser' },
  });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState,
    locale: 'en-US',
  });
  page = await context.newPage();
  const row = () => page.getByTestId('mcp-oauth-oauth-fixture');
  const health = (label) =>
    row().getByText(label, { exact: true }).waitFor({ timeout: 15000 });
  const open = async () => {
    await page.goto(`${base}/settings?tab=app-mcp-servers`);
    await row().waitFor({ timeout: 30000 });
  };
  const shot = async (name) => {
    await page.screenshot({ path: `${evidence}/${name}.png`, animations: 'disabled' });
    result.steps.push({ name, row: (await row().innerText()).split('\n'), grants: grants() });
  };
  const consent = async (button) => {
    const popup = context.waitForEvent('page', { timeout: 15000 });
    await row().getByRole('button', { name: button }).click();
    const consentPage = await popup;
    await consentPage.waitForURL(/\/oauth\/mcp\/callback/, { timeout: 15000 });
    await consentPage.close();
    await health('Connected');
  };

  await open();
  await health('Disconnected');
  result.plainHttpControls = await page.getByTestId('mcp-oauth-plain-http').count();
  assert.equal(result.plainHttpControls, 0, 'a row without a matching preset shows OAuth controls');
  await shot('1-never-connected');
  result.vendorRows = {};
  for (const vendor of ['jira', 'basecamp']) {
    const vendorRow = page.getByTestId(`mcp-oauth-${vendor}`);
    await vendorRow.getByText('Disconnected', { exact: true }).waitFor({ timeout: 15000 });
    result.vendorRows[vendor] = (await vendorRow.innerText()).split('\n');
    assert.equal(await vendorRow.getByRole('button', { name: 'Connect' }).count(), 1, vendor);
  }
  const slack = page.getByTestId('mcp-oauth-slack');
  const slackConnect = slack.getByRole('button', { name: 'Connect' });
  await slack.getByLabel('Client ID').waitFor({ timeout: 15000 });
  assert.equal(await slackConnect.isDisabled(), true, 'Slack Connect is enabled without a client');
  assert.equal(await slack.getByLabel('Client secret').getAttribute('type'), 'password');
  await slack.getByLabel('Client ID').fill('synthetic-client');
  await slack.getByLabel('Client secret').fill('synthetic-secret');
  assert.equal(await slackConnect.isDisabled(), false, 'Slack Connect stays disabled');
  await slack.screenshot({ path: `${evidence}/slack-row.png`, animations: 'disabled' });
  result.slackRow = 'client fields shown; Connect enabled only once both are filled';
  await slack.getByLabel('Client secret').fill('');

  await consent('Connect');
  await shot('2-connected');
  await page.reload();
  await health('Connected');
  await shot('3-connected-after-reload');
  assert.equal(grants(), 1);

  execFileSync('sqlite3', [db, `DELETE FROM provider_credentials WHERE ${grantFilter}`]);
  await open();
  await health('Reconnect needed');
  await shot('4-reconnect-needed');

  await consent('Reconnect');
  await shot('5-reconnected');

  await row().getByRole('button', { name: 'Disconnect' }).click();
  await health('Disconnected');
  assert.equal(await row().getByRole('button', { name: 'Disconnect' }).count(), 0);
  await page.reload();
  await health('Disconnected');
  await shot('6-disconnected-after-reload');
  assert.equal(grants(), 0);

  await consent('Reconnect');
  assert.equal(grants(), 1);
  await page.locator('div.px-4.py-3', { has: row() }).getByTitle('Delete').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await row().waitFor({ state: 'detached', timeout: 15000 });
  await page.screenshot({ path: `${evidence}/7-removed.png`, animations: 'disabled' });
  result.grantsAfterRemove = grants();
  assert.equal(result.grantsAfterRemove, 0);
  result.pass = true;
} catch (error) {
  result.error = String(error);
  await page?.screenshot({ path: `${evidence}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${evidence}/mcp-oauth-settings.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
