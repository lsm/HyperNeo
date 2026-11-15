import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run);
assert.notEqual(String(port), '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const out = `${run}/evidence`;
const base = `http://127.0.0.1:${port}`;
const made = JSON.parse(
  execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', '{"kind":"human"}'], {
    encoding: 'utf8',
  })
).reply;
const pairing = await browser.newContext();
const paired = await pairing.request.post(`${base}/pair`, {
  headers: { origin: base },
  data: { code: made.code, name: 'Synthetic controls browser' },
});
assert.equal(paired.status(), 200);
const storageState = await pairing.storageState();
await pairing.close();
mkdirSync(out, { recursive: true });
const seen = {};
const settle = (page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    )
  );
const look = (section) =>
  section.evaluate((node) => {
    let opacity = 1;
    for (let el = node; el; el = el.parentElement) opacity *= Number(getComputedStyle(el).opacity);
    return {
      opacity,
      disabled: [...node.querySelectorAll('input')].map((input) => input.disabled),
    };
  });
async function open(context, width) {
  const page = await context.newPage();
  await page.goto(`${base}/neo`);
  if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
  const card = page.locator('[data-ask="controls"]:visible');
  await card.waitFor().catch(async (error) => {
    await page.screenshot({ path: `${out}/open-failed-${width}.png` });
    throw error;
  });
  await settle(page);
  return { page, card };
}
const row = (card, id) => card.locator(`[data-ask-todo="${id}"]`);
async function pick(page, card, title, item) {
  await card.getByRole('button', { name: `Step actions: ${title}` }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}
try {
  const desktop = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  try {
    const { page, card } = await open(desktop, 1280);
    assert.equal(await row(card, 'controls-hold').locator('[data-todo-priority="high"]').innerText(), 'High');
    assert.equal(await card.locator('[data-todo-priority]').count(), 2);
    await card.screenshot({ path: `${out}/list-1280.png` });
    await card.getByRole('button', { name: 'Step actions: Run the data migration' }).click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    seen.runningMenu = await menu.getByRole('menuitem').allInnerTexts();
    await page.waitForTimeout(400);
    await settle(page);
    await page.screenshot({ path: `${out}/menu-1280.png` });
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });

    await pick(page, card, 'Tag the release', 'Priority: Urgent');
    await row(card, 'controls-priority').locator('[data-todo-priority="urgent"]').waitFor();

    await pick(page, card, 'Update the changelog', 'Mark done');
    await card.locator('[data-ask-todo="controls-done"][data-todo-state="todo"]').waitFor({ state: 'detached' });

    await pick(page, card, 'Draft the blog post', 'Cancel this step');
    await card.locator('[data-ask-todo="controls-cancel"][data-todo-state="todo"]').waitFor({ state: 'detached' });
    await pick(page, card, 'Run the data migration', 'Pause');
    const paused = card.getByText('"Run the data migration" is paused: The human paused it. Resume it, or remove it?');
    await paused.waitFor();
    await pick(page, card, 'Write the release notes', 'Hold');
    const held = card.getByText('"Write the release notes" is on hold: The human put it on hold. Start it, or remove it?');
    await held.waitFor();
    await settle(page);
    await card.screenshot({ path: `${out}/cards-1280.png` });

    const holdBox = card.locator('[data-ask-question]').filter({ hasText: 'is on hold' });
    await holdBox.getByRole('button', { name: 'Start', exact: true }).click();
    await held.waitFor({ state: 'detached' });
    seen.alerts = await card.locator('[data-todo-control-error]').allInnerTexts();
    seen.afterStart = await card.locator('[data-ask-question]').allInnerTexts();
    await settle(page);
    await card.screenshot({ path: `${out}/after-start-1280.png` });

    await page.goto(`${base}/settings?tab=neo-model`);
    const total = page.getByRole('spinbutton', { name: 'Running steps in total' });
    const perProject = page.getByRole('spinbutton', { name: 'Running steps per project' });
    await total.waitFor();
    seen.limitsBefore = [await total.inputValue(), await perProject.inputValue()];
    await total.fill('4');
    await total.press('Tab');
    await perProject.fill('2');
    await perProject.press('Tab');
    await page.waitForTimeout(500);
    await page.reload();
    await total.waitFor();
    seen.limitsAfterReload = [await total.inputValue(), await perProject.inputValue()];
    const section = page.locator('section', { hasText: 'Running limits' }).last();
    await section.scrollIntoViewIfNeeded();
    await settle(page);
    seen.limits1280 = await look(section);
    await page.screenshot({ path: `${out}/limits-1280.png` });
    seen.overflow1280 = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  } finally {
    await desktop.close();
  }
  const phone = await browser.newContext({
    storageState,
    viewport: { width: 390, height: 844 },
    locale: 'en-US',
    isMobile: true,
    hasTouch: true,
  });
  try {
    const { page, card } = await open(phone, 390);
    await card.screenshot({ path: `${out}/list-390.png` });
    await card.getByRole('button', { name: 'Step actions: Tag the release' }).click();
    await page.getByRole('menu').waitFor();
    await page.waitForTimeout(400);
    await settle(page);
    seen.phoneMenu = await page.getByRole('menu').getByRole('menuitem').allInnerTexts();
    await page.getByRole('menu').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/menu-390.png` });
    seen.overflow390 = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.keyboard.press('Escape');
    await page.goto(`${base}/settings?tab=neo-model`);
    const section = page.locator('section', { hasText: 'Running limits' }).last();
    await section.waitFor();
    await section.scrollIntoViewIfNeeded();
    await settle(page);
    seen.limits390 = await look(section);
    await section.screenshot({ path: `${out}/limits-390.png` });
  } finally {
    await phone.close();
  }
} finally {
  writeFileSync(`${out}/human-controls-web.json`, JSON.stringify(seen, null, 2));
  await browser.close();
}
const menu = seen.runningMenu.map((label) => label.replace('✓', '').trim());
assert.deepEqual(menu, [
  'Mark done',
  'Pause',
  'Priority: Urgent',
  'Priority: High',
  'Priority: Normal',
  'Priority: Low',
  'Cancel this step',
]);
assert.deepEqual(seen.limitsBefore, ['6', '3']);
assert.deepEqual(seen.limitsAfterReload, ['4', '2']);
assert.equal(seen.overflow1280, false);
assert.equal(seen.overflow390, false);
assert.deepEqual(seen.alerts, []);
for (const limits of [seen.limits1280, seen.limits390]) {
  assert.equal(limits.opacity, 1);
  assert.deepEqual(limits.disabled, [false, false]);
}
assert(seen.phoneMenu.some((label) => label.includes('Hold')));
console.log('human-controls web: PASS');
