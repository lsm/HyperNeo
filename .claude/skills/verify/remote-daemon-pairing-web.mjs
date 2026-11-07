import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [localPort, remotePort, run] = process.argv.slice(2);
assert(localPort && remotePort && run, 'usage: <local-port> <remote-port> <run>');
const rpc = (port, dir, name, input) => execFileSync('bun', [
  '.claude/skills/verify/rpc.ts', name, JSON.stringify(input),
], { encoding: 'utf8', env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, dir, 'data') } });
const createCode = (port, dir) => {
  const text = rpc(port, dir, 'device.pair.create', { kind: 'human', name: 'Synthetic pairing' });
  const code = text.match(/"code":\s*"([^"]+)"/)?.[1];
  assert(code, 'pairing code missing');
  return code;
};
const browserCode = createCode(localPort, 'local');
const remoteCode = createCode(remotePort, 'remote');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${localPort}`;
  await page.goto(`${base}/pair#${browserCode}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${base}/settings?tab=remote-daemons`);
  await page.getByLabel('Daemon id').fill('synthetic');
  await page.getByLabel('MessageHub URL').fill(`ws://127.0.0.1:${remotePort}/ws`);
  await page.getByLabel('Pairing code (optional)').fill('wrong-code');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.getByRole('alert').getByText(/pairing refused/i).waitFor();
  await page.screenshot({ path: join(run, 'local', 'evidence', 'remote-pairing-refused-1280.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const box = document.querySelector('#remote-daemon-code')?.getBoundingClientRect();
    return box && box.x >= 0 && box.right <= innerWidth;
  });
  await page.getByLabel('Pairing code (optional)').click();
  await page.waitForFunction(() => {
    const nav = document.querySelector('nav[aria-label="Settings sections"]');
    return nav && nav.getBoundingClientRect().right <= 0;
  });
  await page.screenshot({ path: join(run, 'local', 'evidence', 'remote-pairing-refused-390.png') });
  await page.getByLabel('Pairing code (optional)').fill(remoteCode);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.getByText('daemon:synthetic::session:<sessionId>').waitFor();
  assert.equal(await page.getByLabel('Pairing code (optional)').inputValue(), '');
  console.log('PASS: wrong code refused visibly; valid code attached and cleared at 1280 and 390 widths');
} finally { await browser.close(); }
