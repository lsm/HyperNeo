import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [port, run, targetJson] = process.argv.slice(2);
const target = JSON.parse(targetJson);
const base = `http://127.0.0.1:${port}`;
const credential = readFileSync(0, 'utf8');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
let count = 0;
try {
  for (const device of ['desktop', 'phone']) {
    const touch = device === 'phone';
    const context = await browser.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: touch,
      hasTouch: touch,
      locale: 'en-US',
      colorScheme: 'light',
    });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === base ? route.continue() : route.abort()
    );
    await context.addCookies([{ name: 'hyperneo_device', value: credential, url: base }]);
    const page = await context.newPage();
    const press = (element) => touch ? element.tap() : element.click();
    const screen = (suffix) =>
      page.screenshot({ path: join(run, 'evidence', `oxap-${device}-${suffix}.png`), animations: 'disabled' });
    try {
      if ('detected' in target) {
        await page.goto(`${base}/settings?tab=providers`);
        assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch);
        await press(page.getByText('Synthetic OXAP Codex', { exact: true }).first());
        await page.getByLabel('Harness', { exact: true }).selectOption('oxap-codex');
        const field = page.getByLabel('Codex CLI path');
        assert.equal(await field.inputValue(), target.detected);
        assert.equal(await field.getAttribute('placeholder'), 'Absolute path to codex');
        await screen('settings');
        await field.fill(target.wrongPath);
        await press(page.getByRole('button', { name: 'Save harness' }));
        await page.getByText(new RegExp('did not respond as the Codex CLI')).waitFor();
      } else {
        await page.goto(`${base}/session/${target.sessions[device]}`);
        assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch);
        await page.getByText('This harness accepts text only', { exact: false }).waitFor();
        await page.getByText('Ready', { exact: true }).waitFor();
        const composer = page.getByPlaceholder('Ask or make anything...');
        await composer.pressSequentially('Send with a previously saved wrong CLI');
        await press(page.getByRole('button', { name: 'Send message' }));
        const error = page.locator('.bg-danger\\/10').filter({ hasText: 'API Error' })
          .getByText(target.launchError, { exact: true });
        await error.waitFor({ timeout: 20_000 });
        assert.equal(await page.getByText('Create a new session', { exact: true }).count(), 0);
        await page.getByRole('button', { name: 'Dismiss notification' }).first()
          .waitFor({ state: 'hidden', timeout: 15_000 });
        await error.scrollIntoViewIfNeeded();
        await screen('chat-error');
      }
      count++;
    } catch (error) {
      writeFileSync(join(run, 'evidence', `oxap-${device}-browser.txt`), await page.locator('body').innerText());
      await screen('browser-failure');
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`Verified ${count} viewport variants for ${'detected' in target ? 'settings' : 'chat launch errors'}.`);
