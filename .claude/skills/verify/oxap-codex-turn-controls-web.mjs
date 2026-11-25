import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [port, sessionId, run] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const credential = readFileSync(0, 'utf8');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  await context.addCookies([{ name: 'hyperneo_device', value: credential, url: base }]);
  const page = await context.newPage();
  const screenshot = (name) => page.screenshot({ path: join(run, 'evidence', `${name}.png`) });
  await page.goto(`${base}/session/${sessionId}`);
  const composer = page.locator('textarea').first();
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('Run the shell command `sleep 15`, then reply exactly TURN-CONTROLS-FIRST.');
  await send.click();
  await page.getByRole('button', { name: 'Stop generation' }).waitFor();
  await composer.fill('Reply exactly TURN-CONTROLS-NEXT. Use no tools.');
  const queue = page.getByRole('button', { name: 'Queue for next turn' });
  await queue.waitFor();
  const steerButtons = await page.getByRole('button', { name: 'Steer current turn' }).count();
  await screenshot('active-composer');
  await queue.click();
  const remove = page.getByRole('button', { name: /Delete queued message:/ });
  await remove.waitFor();
  const promoteButtons = await page.getByRole('button', { name: /Move queued message to Steer/ }).count();
  await screenshot('queued-message');
  await page.getByText('TURN-CONTROLS-FIRST', { exact: true }).last().waitFor({ timeout: 90000 });
  await page.getByText('TURN-CONTROLS-NEXT', { exact: true }).last().waitFor({ timeout: 90000 });
  await composer.fill('/compact');
  await send.click();
  const unavailable = page.getByText('Manual compaction is unavailable in OXAP Codex.', { exact: true });
  const compactRefused = await unavailable.waitFor({ timeout: 5000 }).then(() => true, () => false);
  await screenshot('manual-compact');
  const compactPreserved = (await composer.inputValue()) === '/compact';
  const observed = { steerButtons, promoteButtons, compactRefused, compactPreserved };
  console.log(JSON.stringify(observed));
  assert.deepEqual(observed, { steerButtons: 0, promoteButtons: 0, compactRefused: true, compactPreserved: true });
} finally {
  await browser.close();
}
