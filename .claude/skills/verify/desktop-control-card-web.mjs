import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { revealAsk } from './queue-ask.mjs';

const [port, out, run] = process.argv.slice(2);
assert(port && out && run);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`;
const contexts = [];
let currentPage;
let chinesePage;
try {
  for (const [name, width, height, dark] of [['wide-light', 1280, 800, false], ['wide-dark', 1280, 800, true], ['phone-light', 390, 844, false], ['wide-zh', 1280, 800, false], ['phone-dark', 390, 844, true]]) {
    const touch = width === 390;
    const context = await browser.newContext({ viewport: { width, height }, locale: name === 'wide-zh' ? 'zh-CN' : 'en-US', colorScheme: dark ? 'dark' : 'light', reducedMotion: 'reduce', ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    contexts.push(context);
    await context.route('**/*', (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    currentPage = page;
    if (name === 'wide-zh') chinesePage = page;
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
    const zh = name === 'wide-zh';
    for (const label of zh ? ['不行', '只这个任务', '可以，以后不用再问'] : ['No', 'Only this task', "Yes, don't ask again"])
      await card.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: join(out, `${name}.png`) });
    if (touch) await page.getByRole('button', { name: 'Close work list' }).tap();
    await page.getByRole('button', { name: zh ? '设置' : 'Settings', exact: true }).first().click();
    const toggle = page.getByRole('switch', { name: zh ? '直接使用，不用问' : 'Use without asking' });
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `${name}-switch.png`) });
    if (name === 'wide-light') {
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true');
      await page.screenshot({ path: join(out, `${name}-switch-on.png`) });
      const saved = JSON.parse(execSync(`env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts pack.preferences.get '{"pack":"core","scope":{"kind":"global","key":""},"key":"desktopControl"}'`, { encoding: 'utf8' })).reply;
      assert.equal(saved.preference?.value, true, 'the switch must save core.desktopControl');
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false');
    }
    await page.keyboard.press('Escape');
    await toggle.waitFor({ state: 'hidden' });
    if (touch) {
      await page.getByRole('button', { name: /^Your work/ }).first().tap();
      await card.waitFor();
    }
    if (name === 'wide-light') {
      const questionId = JSON.parse(readFileSync(join(out, 'card.json'), 'utf8')).reply.question.id;
      await card.getByRole('button', { name: 'Reply in chat' }).click();
      const composer = page.getByRole('textbox', { name: 'Message Neo', exact: true });
      await composer.fill('Yes, allow it');
      await composer.press('Enter');
      await page.getByText('Yes, allow it', { exact: true }).first().waitFor();
      const response = JSON.parse(execSync(`env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts neo.question.get '{"questionId":"${questionId}"}'`, { encoding: 'utf8' })).reply;
      assert.equal(response.question.state, 'open', 'chat must not answer the desktop control card');
      const status = JSON.parse(execSync(`env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts desktop.status '{}'`, { encoding: 'utf8' })).reply;
      assert.equal(status.workers.find((worker) => worker.worker === 'worker-dentist')?.state, 'off');
      await card.waitFor();
    }
    if (name === 'phone-dark') {
      await card.getByRole('button', { name: 'Only this task' }).tap();
      await card.waitFor({ state: 'hidden' });
      assert(chinesePage);
      await chinesePage.reload();
      const ask = await revealAsk(chinesePage, 'desktop-ask');
      await ask.locator('[data-ask-details-toggle]').first().click();
      const questionId = JSON.parse(readFileSync(join(out, 'card.json'), 'utf8')).reply.question.id;
      const answered = chinesePage.locator(`#neo-ref-question-${questionId} [data-question-answer]`).first();
      await answered.waitFor();
      await chinesePage.screenshot({ path: join(out, 'answered-zh.png') });
      assert.match(await answered.innerText(), /只这个任务/, 'the answered card action must use Chinese');
    }
  }
  console.log('PASS: five views named the todo and app and showed the switch; the switch saved; Only this task closed the card');
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
