import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [port, code, output] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const sessionId = /CLAUDE_PICKER_SESSION=([\w-]+)/.exec(
  readFileSync(join(output, 'daemon.log'), 'utf8')
)?.[1];
assert(sessionId, 'Expected an existing Claude Code chat');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  const paired = await page.request.post(`${base}/pair`, {
    headers: { origin: base },
    data: { code, name: 'Synthetic picker browser' },
  });
  assert.equal(paired.status(), 200);
  const alternateName = /^GPT-5\.6-Luna ·/;
  await page.goto(`${base}/sessions`);
  await page.getByRole('button', { name: 'Choose model, client and thinking' })
    .and(page.locator('[aria-description="Client: OXAP Codex"]')).click();
  await page.getByRole('button', { name: /^Model,/ }).click();
  const newMenu = page.getByRole('group', { name: 'Models', exact: true });
  await newMenu.getByRole('button', { name: alternateName }).waitFor();
  await newMenu.screenshot({ path: join(output, 'new-chat-picker.png') });
  console.log('New OXAP Codex chat shows GPT-5.6-Luna');

  let releaseSwitch;
  const switchRequest = new Promise((resolve) => {
    releaseSwitch = resolve;
  });
  await page.routeWebSocket('**/ws', (client) => {
    const server = client.connectToServer();
    client.onMessage((raw) => {
      if (JSON.parse(String(raw)).method === 'session.model.switch') {
        releaseSwitch(() => server.send(raw));
        return;
      }
      server.send(raw);
    });
  });

  await page.goto(`${base}/session/${sessionId}`);
  const picker = page.getByRole('button', { name: 'Choose model and thinking' });
  await picker.click();
  const menu = page.getByRole('group', { name: 'Model and thinking settings' });
  await menu.getByRole('slider', { name: 'Thinking' }).waitFor();
  const alternate = menu.getByRole('button', { name: alternateName });
  try {
    await alternate.waitFor({ timeout: 5000 });
  } finally {
    await menu.screenshot({ path: join(output, 'existing-claude-picker.png') });
    console.log(`Existing Claude Code picker: ${await menu.innerText()}`);
  }
  await alternate.click();
  const forwardSwitch = await Promise.race([switchRequest, delay(5_000)]);
  assert.equal(typeof forwardSwitch, 'function', 'Expected the legacy model switch RPC');
  assert.equal(await picker.isDisabled(), true, 'Picker must be disabled during switching');
  await delay(11_000);
  assert.equal(await picker.isDisabled(), true, 'Picker timed out before the 11-second reply');
  await picker.screenshot({ path: join(output, 'existing-claude-picker-pending.png') });
  forwardSwitch();
  const switched = picker.filter({ hasText: '5.6-Luna' }).and(page.locator('button:enabled'));
  await switched.waitFor();
  await page.reload();
  await picker.filter({ hasText: '5.6-Luna' }).waitFor();
  console.log('Existing Claude Code picker stayed disabled past 10 seconds, switched to GPT-5.6-Luna, and kept it after reload');
} finally {
  await browser.close();
}
