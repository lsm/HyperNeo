import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

export async function verifyHubLossToast({ port, sessionId, run }: {
  port: number;
  sessionId: string;
  run: string;
}) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
  try {
    const base = `http://127.0.0.1:${port}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'hyperneo_device', value: readLocalCredential(), url: base }]);
    const page = await context.newPage();
    await page.goto(`${base}/session/${sessionId}`);
    const input = page.getByPlaceholder('Ask or make anything...');
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await input.fill('Run the shell command sleep 15 now.');
    await send.click();
    await page.getByRole('button').filter({ hasText: /sleep 15/ }).first().waitFor({ timeout: 45_000 });

    const children = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
    const hubPids = children.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match || Number(match[2]) !== process.pid || !match[3].startsWith(`${run}/data/oap/`) || !match[3].endsWith('/oxap')) return [];
      return [Number(match[1])];
    });
    assert.equal(hubPids.length, 1, 'exactly one hub owned by this proof');
    process.kill(hubPids[0], 'SIGKILL');

    const toast = page.getByRole('alert').filter({ hasText: /OAP hub exited/ }).first();
    await toast.waitFor({ timeout: 10_000 });
    assert.match(await toast.innerText(), /Disposable Codex diagnostic line/);
    await input.fill('Reply exactly RECOVERED-731. Use no tools.');
    await page.screenshot({ path: join(run, 'evidence/hub-loss-desktop.png'), animations: 'disabled' });
    await send.click({ trial: true, timeout: 1_000 });
    console.log('Desktop: Send receives a click while the hub-loss toast is visible.');

    await page.setViewportSize({ width: 390, height: 650 });
    await page.screenshot({ path: join(run, 'evidence/hub-loss-compact.png'), animations: 'disabled' });
    await toast.waitFor({ timeout: 1_000 });
    await send.click({ timeout: 1_000 });
    await page.getByText('RECOVERED-731', { exact: true }).last().waitFor({ timeout: 45_000 });
    console.log('Compact: clicked Send while the toast was visible and received the Codex reply.');
  } finally {
    await browser.close();
  }
}
