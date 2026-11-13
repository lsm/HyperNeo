import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: pairing-v2-web-view.mjs <port> <run-dir>');
const code = process.env.PAIR_CODE;
assert(code, 'PAIR_CODE is required');
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const reader = join(dirname(fileURLToPath(import.meta.url)), 'qr-read.swift');
const result = {};

const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const phone = (name) => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
  const signed = (text) => sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64url');
  return {
    bind: async (ticket) => {
      const bound = await post('/pair2/bind', { ticket, phoneKey: key, name });
      assert.equal(bound.status, 200);
      return bound.body;
    },
    complete: ({ requestId, bindNonce }) =>
      post('/pair2/complete', { requestId, phoneKey: key, signature: signed(`${requestId}:${bindNonce}`) }),
  };
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const shot = (name) => page.screenshot({ path: `${run}/evidence/${name}.png` });
  await page.goto(`${base}/pair#${code}`);
  await page.getByLabel('Name for this browser').fill('Verify browser');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  const approve = (requestId) =>
    context.request.post(`${base}/pair2/approve`, { data: { requestId }, headers: { origin: base } });
  const scanQr = async (name) => {
    const qr = page.getByRole('img', { name: 'Pairing QR code' });
    await qr.waitFor({ timeout: 15000 });
    await qr.screenshot({ path: `${run}/evidence/${name}-qr-only.png` });
    const link = execFileSync('swift', [reader, `${run}/evidence/${name}-qr-only.png`], { encoding: 'utf8' }).trim();
    const url = new URL(link);
    assert.equal(`${url.protocol}//${url.host}`, 'hyperneo://pair2');
    assert.equal(url.searchParams.get('v'), '2');
    assert.equal(url.searchParams.get('a'), 'https://neo-verify.example.ts.net');
    return url.searchParams.get('t');
  };

  await page.goto(`${base}/settings?tab=devices`);
  await page.getByRole('button', { name: 'Start pairing' }).click();
  const ticket = await scanQr('first');
  result.countdown = await page.getByText(/Expires in \d+ s/).innerText();
  result.address = await page.getByText('https://neo-verify.example.ts.net').innerText();
  await shot('1-qr');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('1-qr-390');
  await page.setViewportSize({ width: 1280, height: 900 });

  const first = phone('Kitchen iPhone');
  const bound = await first.bind(ticket);
  await page.getByText('Phone scanned. Waiting for confirmation.').waitFor({ timeout: 10000 });
  result.qrHiddenAfterScan = (await page.getByRole('img', { name: 'Pairing QR code' }).count()) === 0;
  assert(result.qrHiddenAfterScan);
  await shot('2-scanned');
  assert.equal((await approve(bound.requestId)).status(), 200);
  assert.equal((await first.complete(bound)).status, 200);
  await page.getByText('Paired with Kitchen iPhone.').waitFor({ timeout: 10000 });
  await shot('3-paired');

  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Start pairing' }).click();
  const late = phone('Late iPhone');
  const lateBound = await late.bind(await scanQr('late'));
  assert.equal((await approve(lateBound.requestId)).status(), 200);
  const cancelReply = page.waitForResponse((response) => response.url().endsWith('/pair2/cancel'));
  const completed = await late.complete(lateBound);
  assert.equal(completed.status, 200);
  const cancel = page.getByRole('button', { name: 'Cancel' });
  if (await cancel.count()) {
    await cancel.click();
    result.lateCancelStatus = (await cancelReply).status();
  }
  await page.getByText('Paired with Late iPhone.').waitFor({ timeout: 10000 });
  await shot('4-late-cancel-paired');

  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Start pairing' }).click();
  await page.getByRole('img', { name: 'Pairing QR code' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByText('Pairing cancelled.').waitFor({ timeout: 10000 });
  result.showNewQr = await page.getByRole('button', { name: 'Show a new QR' }).count();
  await shot('5-cancelled');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Show a new QR' }).click();
  await page.getByRole('img', { name: 'Pairing QR code' }).waitFor({ timeout: 15000 });
  await shot('6-qr-dark');
  writeFileSync(`${run}/evidence/pairing-v2-web.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
