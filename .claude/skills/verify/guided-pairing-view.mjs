import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: guided-pairing-view.mjs <port> <run-dir>');
const deskCode = process.env.PAIR_CODE;
assert(deskCode, 'PAIR_CODE is required');
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium
  .launch({ headless: true })
  .catch(() => chromium.launch({ headless: true, channel: 'chrome' }));
const result = {};
const noteCode = (code) => appendFileSync(`${run}/pairing-codes`, `${code}\n`, { mode: 0o600 });
try {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await desk.newPage();
  await page.goto(`${base}/pair#${deskCode}`);
  await page.getByLabel('Name for this browser').fill('Desk browser');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  await page.goto(`${base}/settings?tab=devices`);
  await page.getByRole('button', { name: 'Start pairing' }).click();
  const codeBox = page.locator('.font-mono.text-lg');
  await codeBox.waitFor({ timeout: 10000 });
  const code = (await codeBox.innerText()).trim();
  noteCode(code);
  result.addressShown = await page.locator('.font-mono.break-all').first().innerText();
  assert(
    result.addressShown.includes(`127.0.0.1:${port}`),
    'the flow shows the daemon address'
  );
  result.networkHint = await page.getByText(/same Wi-Fi or Tailscale/).innerText();
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `${run}/evidence/guided-pairing-waiting-1280.png`,
    fullPage: true,
    mask: [codeBox],
  });
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `${run}/evidence/guided-pairing-waiting-390.png`,
    fullPage: true,
    mask: [codeBox],
  });
  const phone = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Kitchen iPhone' }),
  });
  result.phonePairStatus = phone.status;
  assert.equal(phone.status, 200, 'the phone redeems the shown code');
  await page.getByText('Paired: Kitchen iPhone').waitFor({ timeout: 30000 });
  result.pairedShown = true;
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/guided-pairing-paired-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/guided-pairing-paired-1280.png`, fullPage: true });
  const storage = await desk.storageState();
  await desk.close();

  const dark = await browser.newContext({
    viewport: { width: 1280, height: 1100 },
    colorScheme: 'dark',
    storageState: storage,
  });
  const darkPage = await dark.newPage();
  await darkPage.goto(`${base}/settings?tab=devices`);
  await darkPage.getByRole('button', { name: 'Start pairing' }).click();
  const darkCode = darkPage.locator('.font-mono.text-lg');
  await darkCode.waitFor({ timeout: 10000 });
  noteCode((await darkCode.innerText()).trim());
  await darkPage.waitForTimeout(800);
  await darkPage.screenshot({
    path: `${run}/evidence/guided-pairing-waiting-dark-1280.png`,
    fullPage: true,
    mask: [darkCode],
  });
  result.darkWaiting = true;
  await darkPage.getByRole('button', { name: 'Cancel' }).click();
  await darkPage.getByRole('button', { name: 'Start pairing' }).waitFor({ timeout: 10000 });
  await dark.close();
  writeFileSync(`${run}/evidence/guided-pairing.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
