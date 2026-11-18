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
const chinese = process.env.VERIFY_LOCALE === 'zh-Hans';
const retryLabel = chinese ? '重试' : 'Retry';
const failureText = chinese ? /无法下载 Claude Code：无法连接 npm 软件源 registry\.npmjs\.org。/ : /Can't download Claude Code/;
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, colorScheme: 'dark', locale: chinese ? 'zh-CN' : 'en-US' });
  await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(`${base}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${base}/session/${sessionId}`);
  const banner = page.getByTestId('error-banner');
  await banner.getByText(fixture === 'slow' || fixture === 'timeout' ? /Claude Code is still downloading/ : failureText).waitFor({ timeout: 30000 });
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(run, 'evidence', `download-${mode}-${scheme}.png`), mask: [page.getByTestId('chat-header-folder')], maskColor: scheme === 'dark' ? '#19191b' : '#f8f8fa' });
  }
  const retry = banner.getByRole('button', { name: retryLabel, exact: true });
  assert.equal(await retry.count(), mode === 'after' ? 1 : 0);
  if (mode === 'after') {
    assert.equal(await page.getByRole('button', { name: retryLabel, exact: true }).count(), 1);
    const count = () => execFileSync('/usr/bin/wc', ['-l', join(run, 'data/download.log')], { encoding: 'utf8' }).trim().split(/\s/)[0];
    const before = Number(count());
    const clickedAt = Date.now();
    await retry.click();
    if (fixture === 'timeout') {
      await banner.getByRole('button', { name: 'Retrying…', exact: true }).waitFor();
      await retry.waitFor({ timeout: 185000 });
      assert(Date.now() - clickedAt >= 179000, 'retry returned before its timeout');
      assert.match(await banner.innerText(), /Claude Code is still downloading/);
      assert.doesNotMatch(await banner.innerText(), /Can't retry the Claude Code download/);
      assert.equal(Number(count()), before);
      await page.screenshot({ path: join(run, 'evidence', 'download-timeout-after.png'), mask: [page.getByTestId('chat-header-folder')], maskColor: '#f8f8fa' });
      console.log('browser_retry_timeout=still_downloading');
    } else if (fixture === 'slow') {
      await banner.getByText(failureText).waitFor({ timeout: 30000 });
      assert.equal(Number(count()), before);
    } else {
      for (let attempt = 0; attempt < 50 && Number(count()) === before; attempt++) await page.waitForTimeout(100);
      assert.equal(Number(count()), before + 1);
      await banner.getByText(failureText).waitFor({ timeout: 10000 });
    }
  }
  console.log(`browser_mode=${mode} retry_buttons=${await retry.count()}`);
  await context.close();
} finally {
  await browser.close();
}
