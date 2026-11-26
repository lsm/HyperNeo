import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [localPort, remotePort, run] = process.argv.slice(2);
assert(localPort && remotePort && run, 'usage: <local-port> <remote-port> <run>');
const rpc = (port, dir, name, input) => execFileSync('bun', [
  '.claude/skills/verify/rpc.ts', name, JSON.stringify(input),
], { encoding: 'utf8', env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, dir, 'data') } });
const createCode = (port, dir, kind) => {
  const text = rpc(port, dir, 'device.pair.create', { kind, name: 'Synthetic pairing' });
  const code = text.match(/"code":\s*"([^"]+)"/)?.[1];
  assert(code, 'pairing code missing');
  return code;
};
const browserCode = createCode(localPort, 'local', 'human');
const remoteCode = createCode(remotePort, 'remote', 'daemon');
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
  const edit = page.getByRole('button', { name: 'Edit', exact: true });
  const editCount = await edit.count();
  console.log(`Paired daemon Edit buttons: ${editCount}`);
  assert.equal(editCount, 1, 'The paired daemon should offer Edit');
  await page.reload();
  await edit.waitFor();

  const attachedUrl = `ws://127.0.0.1:${remotePort}/ws`;
  const updatedUrl = `${attachedUrl}?address=updated`;
  const dialog = page.getByRole('dialog', { name: 'Edit remote daemon' });
  const remoteDevices = () => JSON.parse(rpc(remotePort, 'remote', 'device.list', {}))
    .reply.devices.filter(({ kind }) => kind === 'daemon');
  const pairedDevices = remoteDevices();
  assert.equal(pairedDevices.length, 1);
  const [pairedDevice] = pairedDevices;
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await edit.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: join(run, 'local', 'evidence', `remote-daemon-list-${width}.png`) });
    await edit.click();
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('Display name').inputValue(), 'synthetic');
    assert.equal(await dialog.getByLabel('MessageHub URL').inputValue(), attachedUrl);
    assert.equal(await dialog.getByRole('textbox').count(), 2);
    await page.screenshot({ animations: 'disabled', path: join(run, 'local', 'evidence', `remote-daemon-edit-${width}.png`) });
    if (width !== 1280) {
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
  }
  await dialog.getByLabel('Display name').fill('Renamed daemon');
  await dialog.getByLabel('MessageHub URL').fill(updatedUrl);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('Renamed daemon', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Renamed daemon', { exact: true }).waitFor();
  await page.getByText(updatedUrl, { exact: true }).waitFor();
  await page.getByText('daemon:synthetic::session:<sessionId>', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Test', exact: true }).last().click();
  await page.getByText('Remote daemon is reachable', { exact: true }).waitFor();
  const devicesAfterEdit = remoteDevices();
  assert.deepEqual(devicesAfterEdit.map(({ id }) => id), [pairedDevice.id]);
  assert(devicesAfterEdit[0].lastSeenAt > (pairedDevice.lastSeenAt ?? 0));
  console.log('PASS: label and endpoint saved; the edited endpoint reconnected with the original paired device');

  await page.getByLabel('Daemon id').fill('synthetic');
  await page.getByLabel('MessageHub URL').fill(attachedUrl);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.getByText(attachedUrl, { exact: true }).waitFor();
  assert.equal(await edit.count(), 0);
  const refused = JSON.parse(rpc(localPort, 'local', 'daemon.attach', {
    daemonId: 'synthetic', url: attachedUrl, edit: { displayName: 'Unpaired rename' },
  })).reply;
  assert.equal(refused.kind, 'rejected');
  assert.match(refused.reason, /pairing code/);
  await page.getByText('Attach with a pairing code to enable editing.').waitFor({ timeout: 5000 });
  console.log('PASS: a replaced endpoint needs its own pairing before edits are available');
} finally { await browser.close(); }
