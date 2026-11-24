import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [port, executable, replacement, run] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  await context.addCookies([{ name: 'hyperneo_device', value: readFileSync(0, 'utf8'), url: base }]);
  const page = await context.newPage();
  const openProvider = async () => {
    await page.getByText('Synthetic OXAP Codex', { exact: true }).first().click();
    assert.equal(await page.getByLabel('Harness', { exact: true }).inputValue(), 'sdk');
    return page.getByLabel('Codex CLI path');
  };
  await page.goto(`${base}/settings?tab=providers`);
  const field = await openProvider();
  assert.equal(await field.inputValue(), executable);
  await field.fill(replacement);
  await page.getByRole('button', { name: 'Save harness' }).click();
  await page.getByText('Harness saved', { exact: true }).waitFor();
  await page.reload();
  assert.equal(await (await openProvider()).inputValue(), replacement);
  await page.screenshot({ path: join(run, 'evidence/oxap-sdk-provider.png'), animations: 'disabled' });
  await context.close();
} finally {
  await browser.close();
}
