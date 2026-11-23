import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399', 'usage: about-links-view.mjs <port> <run-dir>');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const origin = `http://127.0.0.1:${port}`;
const paths = ['https://github.com/lsm/HyperNeo', 'https://docs.anthropic.com/'];
async function pair(page) {
  const { reply } = JSON.parse(execFileSync('bun', [
    '.claude/skills/verify/rpc.ts',
    'device.pair.create',
    JSON.stringify({ kind: 'human', name: 'About links browser' }),
  ], {
    env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: `${run}/data` },
    encoding: 'utf8',
  }));
  const response = await page.request.post(`${origin}/pair`, {
    headers: { origin },
    data: { code: reply.code, name: 'About links browser' },
  });
  assert.equal(response.status(), 200);
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await pair(page);
  await page.context().route('https://github.com/**', (route) => route.fulfill({ body: 'Synthetic external page' }));
  await page.goto(`${origin}/settings?tab=about`);
  const github = page.getByRole('link', { name: 'GitHub' });
  await github.waitFor({ timeout: 30000 });
  const docs = page.getByRole('link', { name: /docs \(upstream\)/ });
  const result = {
    url: new URL(page.url()).pathname + new URL(page.url()).search,
    github: await github.getAttribute('href'),
    docsLabel: (await docs.innerText()).trim(),
    docsHref: await docs.getAttribute('href'),
  };
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${run}/evidence/about-1280.png` });
  const popupEvent = page.waitForEvent('popup');
  await github.click();
  const popup = await popupEvent;
  await popup.getByText('Synthetic external page').waitFor();
  assert.equal(popup.url(), paths[0]);
  assert.equal(await popup.evaluate(() => window.opener), null);
  await popup.close();
  await page.close();
  const desktop = await browser.newPage();
  await pair(desktop);
  await desktop.addInitScript(() => {
    window.nativeLinks = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, input) => window.nativeLinks.push({ command, ...input }),
    };
  });
  await desktop.goto(`${origin}/settings?tab=about`);
  await desktop.getByRole('link', { name: 'GitHub' }).click();
  await desktop.getByRole('link', { name: /docs \(upstream\)/ }).focus();
  await desktop.keyboard.press('Enter');
  const nativeLinks = await desktop.evaluate(() => window.nativeLinks);
  assert.deepEqual(nativeLinks, paths.map((path) => ({ command: 'plugin:shell|open', path })));
  assert.equal(desktop.url(), `${origin}/settings?tab=about`);
  assert.equal(desktop.context().pages().length, 1);
  result.nativeLinks = nativeLinks;
  writeFileSync(`${run}/evidence/about-links.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(result.url, '/settings?tab=about');
  assert.equal(result.github, 'https://github.com/lsm/HyperNeo');
  assert.equal(result.docsLabel, 'Anthropic / Claude Agent SDK docs (upstream)');
  assert.equal(result.docsHref, 'https://docs.anthropic.com');
} finally {
  await browser.close();
}
