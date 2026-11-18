import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [run, port, sessionId, mode, fixture] = process.argv.slice(2);
const rpc = (...args) => execFileSync('bun', ['.claude/skills/verify/rpc.ts', ...args], {
  encoding: 'utf8',
  env: { ...process.env, VERIFY_PORT: port, HYPERNEO_DATA_DIR: join(run, 'data') },
});
const code = JSON.parse(rpc('device.pair.create', JSON.stringify({ kind: 'human', name: 'Download proof browser' }))).reply.code;
assert(code);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const base = `http://127.0.0.1:${port}`;
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, colorScheme: 'dark' });
  await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${base}/session/${sessionId}`);
  const banner = page.getByTestId('error-banner');
  await banner.getByText(fixture === 'slow' ? /Claude Code is still downloading/ : /Can't download Claude Code/).waitFor({ timeout: 30000 });
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(run, 'evidence', `download-${mode}-${scheme}.png`), mask: [page.getByTestId('chat-header-folder')], maskColor: scheme === 'dark' ? '#19191b' : '#f8f8fa' });
  }
  const retry = banner.getByRole('button', { name: 'Retry', exact: true });
  assert.equal(await retry.count(), mode === 'after' ? 1 : 0);
  if (mode === 'after') {
    assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 1);
    const count = () => execFileSync('/usr/bin/wc', ['-l', join(run, 'data/curl.log')], { encoding: 'utf8' }).trim().split(/\s/)[0];
    const before = Number(count());
    await retry.click();
    if (fixture === 'slow') {
      await banner.getByText(/Can't download Claude Code/).waitFor({ timeout: 30000 });
      assert.equal(Number(count()), before);
    } else {
      for (let attempt = 0; attempt < 50 && Number(count()) === before; attempt++) await page.waitForTimeout(100);
      assert.equal(Number(count()), before + 1);
      await banner.getByText(/Can't download Claude Code/).waitFor({ timeout: 10000 });
    }
  }
  console.log(`browser_mode=${mode} retry_buttons=${await retry.count()}`);
  await context.close();
} finally {
  await browser.close();
}
