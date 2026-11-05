import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const listed = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'daemon.extensions'], {
  env: { ...process.env, HYPERNEO_DATA_DIR: `${run}/data`, VERIFY_PORT: port }, encoding: 'utf8',
})).reply;
assert(listed.extensions.some((extension) => extension.id === 'space'), JSON.stringify(listed));
const evidence = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), daemonExtensions: listed, runs: {} };
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });

async function open(withoutSpace, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'en-US' });
  await page.context().addCookies([{ name: 'hyperneo_device', value: readFileSync(`${run}/data/local-rpc.credential`, 'utf8'), url: `http://127.0.0.1:${port}`, httpOnly: true, sameSite: 'Strict' }]);
  const errors = [];
  const spaceChunks = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => {
    if (/\/assets\/(space-web-extension|SpaceIsland)-/.test(request.url())) spaceChunks.push(request.url());
  });
  if (withoutSpace) {
    await page.routeWebSocket('**/ws', (ws) => {
      const server = ws.connectToServer();
      const asked = new Set();
      ws.onMessage((frame) => {
        try {
          const message = JSON.parse(frame);
          if (message.method === 'operation.invoke' && message.data?.name === 'daemon.extensions') asked.add(message.id);
        } catch {}
        server.send(frame);
      });
      server.onMessage((frame) => {
        try {
          const message = JSON.parse(frame);
          if (asked.has(message.requestId) && message.data?.extensions) {
            message.data.extensions = message.data.extensions.filter((extension) => extension.id !== 'space');
            return ws.send(JSON.stringify(message));
          }
        } catch {}
        ws.send(frame);
      });
    });
  }
  await page.goto(`http://127.0.0.1:${port}/spaces`);
  return { page, errors, spaceChunks };
}

try {
  const withSpace = await open(false, 1280);
  await withSpace.page.getByTestId('spaces-introduction').waitFor();
  await withSpace.page.getByRole('tab', { name: 'Spaces', exact: true }).waitFor();
  assert(withSpace.spaceChunks.length > 0, 'Space chunk loads when the daemon lists Space');
  assert.deepEqual(withSpace.errors, []);
  evidence.runs.withSpace = { url: withSpace.page.url(), spaceChunks: withSpace.spaceChunks.length };
  await withSpace.page.close();

  const desktop = await open(true, 1280);
  await desktop.page.waitForURL(/\/sessions$/);
  await desktop.page.getByRole('button', { name: 'Chats', exact: true }).first().waitFor();
  assert.equal(await desktop.page.getByText('Spaces', { exact: true }).count(), 0);
  assert.equal(await desktop.page.getByRole('tab', { name: 'Spaces', exact: true }).count(), 0);
  await desktop.page.screenshot({ path: `${run}/evidence/no-space-sidebar.png`, clip: { x: 0, y: 0, width: 400, height: 200 }, animations: 'disabled' });
  await desktop.page.keyboard.press('Meta+k');
  const input = desktop.page.getByTestId('command-palette-input');
  await input.fill('>go to');
  await desktop.page.getByText('Go to sessions', { exact: true }).waitFor();
  assert.equal(await desktop.page.getByText('Go to spaces', { exact: true }).count(), 0);
  await desktop.page.screenshot({ path: `${run}/evidence/no-space-desktop.png`, animations: 'disabled' });
  await desktop.page.keyboard.press('Escape');
  await desktop.page.goto(`http://127.0.0.1:${port}/spaces`);
  await desktop.page.waitForURL(/\/sessions$/);
  assert.deepEqual(desktop.spaceChunks, [], 'Space chunk must not load when the daemon omits Space');
  assert.deepEqual(desktop.errors, []);
  evidence.runs.withoutSpaceDesktop = { url: desktop.page.url(), spaceChunks: 0 };
  await desktop.page.close();

  const phone = await open(true, 390);
  await phone.page.waitForURL(/\/sessions$/);
  const tabs = phone.page.getByRole('tab', { name: 'Chats', exact: true });
  await tabs.first().waitFor();
  assert.equal(await phone.page.getByRole('tab', { name: 'Spaces', exact: true }).count(), 0);
  await phone.page.screenshot({ path: `${run}/evidence/no-space-phone.png`, animations: 'disabled' });
  assert.deepEqual(phone.spaceChunks, []);
  assert.deepEqual(phone.errors, []);
  evidence.runs.withoutSpacePhone = { url: phone.page.url(), spaceChunks: 0 };
  evidence.pass = true;
  console.log('PASS: Space loads and shows when daemon.extensions lists it; when the list omits it, /spaces goes to chats, no Spaces tab or command appears, and no Space chunk loads (1280 and 390 px)');
} finally {
  writeFileSync(`${run}/evidence/web-extension-space-gate.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
