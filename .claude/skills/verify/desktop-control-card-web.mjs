import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { revealAsk } from './queue-ask.mjs';

const [port, out, run] = process.argv.slice(2);
assert(port && out && run);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`;
const contexts = [];
let currentPage;
try {
  for (const [name, width, height, dark] of [['wide-light', 1280, 800, false], ['wide-dark', 1280, 800, true], ['phone-light', 390, 844, false], ['phone-dark', 390, 844, true]]) {
    const touch = width === 390;
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce', ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    contexts.push(context);
    await context.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    currentPage = page;
    const result = JSON.parse(execSync(`env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human","name":"Card proof"}'`, { encoding: 'utf8' })).reply;
    assert(result.ok);
    await page.goto(`${base}/pair#${result.code}`);
    await page.getByRole('button', { name: 'Pair this browser' }).click();
    await page.getByText('This browser is paired.').waitFor();
    await page.goto(`${base}/neo`);
    if (touch) {
      const work = page.getByRole('button', { name: /^Your work/ });
      await work.first().waitFor();
      await work.first().tap();
    }
    await revealAsk(page, 'desktop-ask');
    const card = page.locator('[data-question-kind="desktop_control"]').first();
    await card.waitFor();
    assert.match(await card.innerText(), /Book the dentist on the clinic site/);
    assert.match(await card.innerText(), /Calendar/);
    await page.screenshot({ path: join(out, `${name}.png`) });
    if (name === 'phone-dark') {
      await card.getByRole('button', { name: 'Allow' }).tap();
      await card.waitFor({ state: 'hidden' });
    }
  }
  console.log('PASS: four views named the todo and app; Allow closed the card');
} catch (error) {
  if (currentPage) {
    await currentPage.screenshot({ path: join(out, 'failure.png') });
    console.error((await currentPage.locator('body').innerText()).slice(0, 4000));
  }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
