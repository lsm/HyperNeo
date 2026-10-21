import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: devices-settings-view.mjs <port> <run-dir>');
const code = process.env.PAIR_CODE;
const pendingCommand = process.env.PENDING_COMMAND;
assert(code && pendingCommand, 'PAIR_CODE and PENDING_COMMAND are required');
const { chromium } = createRequire(import.meta.url)('playwright');
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true });
const result = {};
try {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  const page = await desk.newPage();
  await page.goto(`${base}/pair#${code}`);
  await page.getByLabel('Name for this browser').fill('Desk browser');
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  const relayCode = JSON.parse(execFileSync('bash', ['-c', pendingCommand], { encoding: 'utf8' })).code;
  await page.goto(`${base}/settings?tab=devices`);
  await page.getByRole('button', { name: 'Allow Push relay' }).waitFor({ timeout: 30000 });
  result.unpairedRow = await page.getByText('https://evil.example').first().innerText();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/devices-1280.png`, fullPage: true });
  await page.getByRole('button', { name: 'Allow Push relay' }).click();
  await page.getByText('No codes are waiting for Allow.').waitFor({ timeout: 10000 });
  result.allowed = true;
  result.relayPaired = (
    await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: relayCode, name: 'Push relay' }),
    })
  ).status;
  await page.reload();
  await page.getByText('This browser').waitFor({ timeout: 30000 });
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/devices-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.getByRole('button', { name: 'Re-pair Push relay' }).click();
  const newCode = page.locator('.font-mono.text-lg');
  await newCode.waitFor({ timeout: 10000 });
  await page.getByText('Revoked').waitFor({ timeout: 10000 });
  result.repairHint = await page.getByText('Enter this code on the push relay.').innerText();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/devices-repaired-1280.png`, fullPage: true, mask: [newCode] });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const small = await phone.newPage();
  await small.goto(`${base}/settings?tab=devices`);
  await small.getByText('Pair this browser to manage devices.').waitFor({ timeout: 30000 });
  await small.waitForTimeout(800);
  await small.screenshot({ path: `${run}/evidence/devices-unpaired-390.png` });
  result.unpairedBrowserPrompt = true;
  writeFileSync(`${run}/evidence/devices-settings.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
