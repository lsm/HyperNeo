import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Where a human finds "Let the agent use this computer" on the Neo page, at
// desktop and phone widths, for doing, blocked and not-started todos.
const [port, out, run] = process.argv.slice(2);
assert(port && out && run, 'usage: desktop-control-where-web.mjs <port> <evidence-dir> <run-dir>');
assert.notEqual(port, '8399');
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const pairCode = () => {
  const reply = JSON.parse(
    execSync(
      `env -i HOME="${run}/home" PATH="${process.env.PATH}" NODE_ENV=test HYPERNEO_DATA_DIR="${run}/data" VERIFY_PORT=${port} bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human","name":"Desktop control where"}'`,
      { encoding: 'utf8' }
    )
  ).reply;
  assert(reply.ok, JSON.stringify(reply));
  return reply.code;
};
const LABEL = 'Let the agent use this computer';
const TODOS = {
  dentist: 'Book the dentist on the clinic site',
  taxes: 'File the tax form',
  passport: 'Renew the passport online',
  flights: 'Compare flights',
};
const observations = {};
const open = async (viewport, touch) => {
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}),
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  await page.goto(`${base}/pair#${pairCode()}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`${base}/neo`);
  return { context, page };
};
const visibleSwitches = (page) =>
  page
    .getByRole('checkbox', { name: LABEL })
    .evaluateAll((boxes) => boxes.filter((box) => box.getClientRects().length > 0).length);
const expandAll = async (page) => {
  const result = {};
  for (const [id, title] of Object.entries(TODOS)) {
    const row = page.locator(`[data-ask-todo="${id}"]`).first();
    if (!(await row.count())) {
      result[id] = { rowRendered: false };
      continue;
    }
    const show = row.getByRole('button', { name: `Show details: ${title}` });
    const hasChevron = (await show.count()) > 0;
    if (hasChevron) await show.click();
    const box = row.getByRole('checkbox', { name: LABEL });
    await box.waitFor({ timeout: 5000 }).catch(() => {});
    result[id] = { rowRendered: true, hasChevron, switchAfterExpand: await box.isVisible() };
  }
  return result;
};
const frame = async (page, selector, name) => {
  await page.waitForTimeout(400);
  const card = page.locator(selector).first();
  if (!(await card.count())) return;
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(out, name) });
};
const firstRow = (page) =>
  page.locator('[data-ask-todo="dentist"]').first().waitFor({ timeout: 8000 }).catch(() => {});
try {
  // Desktop: the work column sits beside the chat.
  const desk = await open({ width: 1280, height: 900 }, false);
  await firstRow(desk.page);
  await desk.page.waitForTimeout(600);
  observations.desktopSwitchesOnLoad = await visibleSwitches(desk.page);
  await desk.page.screenshot({ path: join(out, 'desktop-1280-page.png') });
  await frame(desk.page, 'article[data-ask="errands"]', 'desktop-1280-errands-collapsed.png');
  observations.desktopAfterExpand = await expandAll(desk.page);
  observations.desktopSwitchesAfterExpand = await visibleSwitches(desk.page);
  await frame(desk.page, 'article[data-ask="errands"]', 'desktop-1280-errands-expanded.png');
  await desk.context.close();

  // Phone: the work list is a sheet behind the header's "Your work" button.
  const phone = await open({ width: 390, height: 844 }, true);
  await phone.page.waitForTimeout(1500);
  await phone.page.screenshot({ path: join(out, 'phone-390-page.png') });
  const work = phone.page.getByRole('button', { name: /^Your work/ });
  observations.phoneWorkButton = (await work.count())
    ? await work.first().getAttribute('aria-label')
    : null;
  await work.first().tap();
  await firstRow(phone.page);
  await phone.page.waitForTimeout(600);
  observations.phoneSwitchesInSheet = await visibleSwitches(phone.page);
  await phone.page.screenshot({ path: join(out, 'phone-390-work-sheet.png') });
  observations.phoneAfterExpand = await expandAll(phone.page);
  observations.phoneSwitchesAfterExpand = await visibleSwitches(phone.page);
  await frame(phone.page, 'article[data-ask="errands"]', 'phone-390-errands-expanded.png');
  await phone.context.close();
} finally {
  writeFileSync(join(out, 'where-observations.json'), JSON.stringify(observations, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify(observations));
const reachable = { rowRendered: true, hasChevron: true, switchAfterExpand: true };
assert.equal(observations.desktopSwitchesOnLoad, 0);
for (const width of ['desktop', 'phone'])
  for (const id of Object.keys(TODOS))
    assert.deepEqual(observations[`${width}AfterExpand`][id], reachable, `${width} ${id}`);
assert.equal(observations.desktopSwitchesAfterExpand, Object.keys(TODOS).length);
assert.equal(observations.phoneSwitchesAfterExpand, Object.keys(TODOS).length);
