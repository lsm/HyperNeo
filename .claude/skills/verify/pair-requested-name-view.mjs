import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const port = process.argv[2];
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const requester = await browser.newContext();
  const page = await requester.newPage();
  await page.goto(`${base}/pair#${process.env.PAIR_CODE}`);
  await page.getByLabel('Name for this browser').fill('Browser label');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText(/waiting for.*allow/i).first().waitFor({ timeout: 15000 });
  const owner = await browser.newContext();
  await owner.addCookies([{ name: 'hyperneo_device', value: process.env.OWNER_CREDENTIAL, url: base, httpOnly: true, sameSite: 'Strict' }]);
  const settings = await owner.newPage();
  await settings.goto(`${base}/settings?tab=devices`);
  await settings.getByRole('button', { name: 'Allow Browser label' }).waitFor({ timeout: 30000 });
  assert.equal(await settings.getByText('Code label', { exact: true }).count(), 0);
  console.log('Settings: Browser label appears in Waiting for Allow');
  const neo = await owner.newPage();
  await neo.goto(`${base}/neo`);
  await neo.getByRole('button', { name: /settings and connection|设置和连接/i }).click({ timeout: 30000 });
  await neo.getByRole('button', { name: 'Allow Browser label' }).waitFor({ timeout: 30000 });
  console.log('Neo drawer: Browser label appears in Pending devices');
} finally {
  await browser.close();
}
