import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { revealAsk } from './queue-ask.mjs';

const [port, out, run] = process.argv.slice(2);
assert(port && out && run, 'usage: desktop-control-toggle-web.mjs <port> <evidence-dir> <run-dir>');
assert.notEqual(port, '8399');
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const pairCode = () => {
  const pair = JSON.parse(
    execSync(
      `env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human","name":"Desktop control proof"}'`,
      { encoding: 'utf8' }
    )
  ).reply;
  assert(pair.ok, JSON.stringify(pair));
  return pair.code;
};
const TITLES = {
  taxes: 'File the tax form',
  visa: 'Pay the visa fee',
  passport: 'Renew the passport online',
};
const press = (locator, touch, options) => (touch ? locator.tap(options) : locator.click(options));
const open = async (viewport, touch) => {
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    reducedMotion: 'reduce',
    ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  await page.goto(`${base}/pair#${pairCode()}`);
  await press(page.getByRole('button', { name: 'Pair this browser' }), touch);
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${base}/neo`);
  if (!touch) await revealAsk(page, 'desktop-ask');
  return { context, page };
};
const reachable = async (page, touch) => {
  const result = {};
  for (const [id, title] of Object.entries(TITLES)) {
    const row = page.locator(`[data-ask-todo="${id}"]`).first();
    await row.waitFor();
    await press(row.getByRole('button', { name: `Step actions: ${title}` }), touch);
    const item = page.getByText('Let it use this computer', { exact: true }).first();
    await item.waitFor();
    if (process.env.VERIFY_OBSTRUCT_SWITCH === '1') {
      await page.evaluate(() => {
        const sheet = document.createElement('div');
        sheet.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent';
        document.body.append(sheet);
      });
    }
    await press(item, touch, { trial: true, timeout: 3000 });
    result[id] = { visible: await item.isVisible(), enabled: await item.isEnabled() };
    await page.keyboard.press('Escape');
    await item.waitFor({ state: 'hidden' });
  }
  return result;
};
const observations = [];
try {
  const { context, page } = await open({ width: 1280, height: 800 }, false);
  const row = () => page.locator('[data-ask-todo="dentist"]').first();
  const lit = (id) => page.locator(`[data-ask-todo="${id}"] [data-todo-desktop]`);
  await row().waitFor();
  const card = row().locator('xpath=ancestor::article[1]');
  const shot = async (name) => {
    await page.waitForTimeout(400);
    await card.screenshot({ path: join(out, name) });
  };
  observations.push({ todo: 'dentist', litBefore: await lit('dentist').count() });
  await shot('todo-off.png');
  await row().getByRole('button', { name: 'Step actions: Book the dentist on the clinic site' }).click();
  await page.getByText('Let it use this computer', { exact: true }).click();
  await lit('dentist').first().waitFor();
  await page.reload();
  await revealAsk(page, 'desktop-ask');
  await lit('dentist').first().waitFor();
  observations.push({ todo: 'dentist', litAfterReload: await lit('dentist').count() });
  await shot('todo-on.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot('todo-on-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  observations.push({ todo: 'taxes', lit: await lit('taxes').count() });
  observations.push({ width: 1280, reachable: await reachable(page, false) });
  await context.close();

  const phone = await open({ width: 390, height: 844 }, true);
  const work = phone.page.getByRole('button', { name: /^Your work/ });
  await phone.page.waitForTimeout(1500);
  const sheet = (await work.count()) > 0;
  if (sheet) await work.first().tap();
  await revealAsk(phone.page, 'desktop-ask');
  await phone.page.locator('[data-ask-todo="visa"]').first().waitFor();
  await phone.page.screenshot({ path: join(out, 'phone-390.png') });
  observations.push({ width: 390, workSheet: sheet, reachable: await reachable(phone.page, true) });
  await phone.context.close();
} finally {
  writeFileSync(join(out, 'web-observations.json'), JSON.stringify(observations, null, 2) + '\n');
  await browser.close();
}
for (const entry of observations.filter((o) => o.reachable)) {
  for (const id of Object.keys(TITLES)) {
    assert.deepEqual(entry.reachable[id], { visible: true, enabled: true }, `${entry.width}px ${id}`);
  }
}
console.log(JSON.stringify(observations));
