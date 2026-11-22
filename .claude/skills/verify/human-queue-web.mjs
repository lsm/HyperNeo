import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [port, directory, phase] = process.argv.slice(2);
assert(port && port !== '8399' && directory && ['before', 'topic-before', 'layout-before', 'after'].includes(phase));
const run = resolve(directory);
const evidence = join(run, 'evidence');
const base = `http://127.0.0.1:${port}`;
const pair = JSON.parse(execFileSync('bun', [
  '.claude/skills/verify/rpc.ts', 'device.pair.create', '{"kind":"human"}',
], { encoding: 'utf8' })).reply;
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observations = [];
try {
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, {
    headers: { origin: base }, data: { code: pair.code, name: 'Synthetic Inbox browser' },
  });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 }, colorScheme: theme });
    await context.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await context.addInitScript((value) => localStorage.setItem('theme', value), theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/neo`);
    const chips = page.locator('[data-topic-chips]');
    const queue = page.locator('[data-human-queue]');
    const hotel = queue.locator('#neo-ref-question-hotel-card');
    await hotel.getByRole('button', { name: 'Hold', exact: true }).waitFor();
    const states = queue.getByRole('group', { name: 'State', exact: true });
    const asks = queue.getByRole('group', { name: 'Ask', exact: true });
    const more = asks.getByRole('combobox', { name: 'More' });
    const measureFilters = async () => {
      const header = await page.locator('[data-work-tabs]').locator('..').boundingBox();
      const stateRow = await states.boundingBox();
      const askRow = await asks.boundingBox();
      const menu = await more.boundingBox();
      const firstChip = await asks.getByRole('button', { name: 'All 4' }).boundingBox();
      assert(header && stateRow && askRow && menu && firstChip);
      return {
        gap: stateRow.y - header.y - header.height,
        askHeight: askRow.height,
        moreWidth: menu.width,
        moreHeight: menu.height,
        rightInset: askRow.x + askRow.width - menu.x - menu.width,
        centerOffset: menu.y + menu.height / 2 - firstChip.y - firstChip.height / 2,
      };
    };
    const checkSavedTopic = async () => {
      await page.evaluate(() => localStorage.setItem('neo:topic-filter', 'pick:travel'));
      await page.reload();
      const state = queue.getByRole('button', { name: /^In progress / });
      await state.waitFor();
      assert.equal(await chips.count(), 0);
      const badge = queue.locator('[data-ask="trip"]').getByRole('button', { name: 'Travel', exact: true });
      await badge.waitFor();
      const savedTopic = { state: await state.innerText(), badgeDisabled: await badge.isDisabled() };
      await page.screenshot({ path: join(evidence, `saved-topic-${theme}.png`), animations: 'disabled' });
      if (phase === 'after') {
        assert.deepEqual(savedTopic, { state: 'In progress 2', badgeDisabled: true });
        await state.click();
        await queue.getByText('Call the garage', { exact: true }).waitFor();
        await queue.getByText('Pack the bags', { exact: true }).waitFor();
      }
      return savedTopic;
    };
    if (phase === 'topic-before') {
      observations.push({ theme, savedTopic: await checkSavedTopic() });
      await context.close();
      continue;
    }
    const form = page.locator('form.neo-composer-input.is-collapsed');
    const attach = form.getByRole('button', { name: 'Attach photos or files' });
    await attach.hover();
    const hover = await attach.evaluate((button) => {
      const face = button.querySelector('span') ?? button;
      const svg = button.querySelector('svg');
      const target = button.getBoundingClientRect();
      const box = face.getBoundingClientRect();
      const icon = svg.getBoundingClientRect();
      const frame = button.closest('form').getBoundingClientRect();
      const style = getComputedStyle(face);
      return {
        target: [target.width, target.height],
        face: [box.width, box.height],
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        iconCenterOffset: [icon.x + icon.width / 2 - box.x - box.width / 2,
          icon.y + icon.height / 2 - box.y - box.height / 2],
        frameCenterOffset: box.y + box.height / 2 - frame.y - frame.height / 2,
        leftInset: box.x - frame.x,
      };
    });
    const rows = {
      standalone: await chips.count(),
      state: await states.getByRole('button').allInnerTexts(),
      ask: await asks.getByRole('button').allInnerTexts(),
      more: await more.count(),
    };
    await page.screenshot({ path: join(evidence, `${phase}-${theme}.png`), animations: 'disabled' });
    const observation = { theme, rows, hover };
    if (phase === 'layout-before' || phase === 'after') observation.filters = await measureFilters();
    observations.push(observation);
    assert.deepEqual(rows.state, ['Waiting on you 4', 'Held 1', 'In progress 2']);
    assert.equal(rows.ask[0], 'All 4');
    assert.equal(rows.more, 1);
    assert.deepEqual(hover.target, [44, 44]);
    assert.notEqual(hover.background, 'rgba(0, 0, 0, 0)');
    if (phase === 'before' || phase === 'layout-before') continue;
    const checkLayout = ({ gap, askHeight, moreWidth, moreHeight, rightInset, centerOffset }) => {
      assert(gap >= 8 && gap <= 16);
      assert(askHeight <= 34);
      assert(moreWidth >= 28 && moreWidth <= 34 && moreWidth === moreHeight);
      assert(Math.abs(rightInset) <= 1 && Math.abs(centerOffset) <= 1);
    };
    checkLayout(observation.filters);
    assert.equal(rows.standalone, 0);
    assert.deepEqual(hover.face, [32, 32]);
    assert(hover.radius.endsWith('%') ? parseFloat(hover.radius) >= 50 : parseFloat(hover.radius) >= 16);
    assert(hover.iconCenterOffset.every((offset) => Math.abs(offset) <= 1));
    assert(Math.abs(hover.frameCenterOffset) <= 1);
    assert(hover.leftInset >= 8);
    const extraAsk = await more.locator('option').last().getAttribute('value');
    assert(extraAsk);
    await more.selectOption(extraAsk);
    assert.deepEqual(await queue.locator('[data-queue-ask]').evaluateAll((groups) =>
      groups.map((group) => group.getAttribute('data-queue-ask'))), [extraAsk]);
    await asks.getByRole('button', { name: 'All 4' }).click();
    await hotel.getByRole('button', { name: 'Hold', exact: true }).click();
    await states.getByRole('button', { name: 'Held 2' }).click();
    await hotel.getByRole('button', { name: 'Take back' }).click();
    await states.getByRole('button', { name: 'Waiting on you 4' }).click();
    await hotel.getByRole('button', { name: 'Hold', exact: true }).waitFor();
    await states.getByRole('button', { name: 'In progress 2' }).click();
    await queue.getByText('Call the garage', { exact: true }).waitFor();
    await asks.getByRole('button', { name: 'Synthetic car service 1' }).click();
    await queue.getByText('Pack the bags', { exact: true }).waitFor({ state: 'detached' });
    const chooser = page.waitForEvent('filechooser');
    await attach.click();
    assert.equal(await (await chooser).isMultiple(), true);
    observation.savedTopic = await checkSavedTopic();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByRole('button', { name: /^Your work/ }).click();
    await hotel.waitFor();
    await page.waitForFunction(() => {
      const menu = document.querySelector('[data-human-queue] select')?.getBoundingClientRect();
      return menu && menu.width > 0 && menu.left >= 0 && menu.right <= innerWidth;
    });
    const mobile = await measureFilters();
    checkLayout(mobile);
    const track = asks.getByRole('button', { name: 'All 4' }).locator('..');
    assert(await track.evaluate((el) => el.scrollWidth > el.clientWidth));
    await track.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    assert(await track.evaluate((el) => el.scrollLeft > 0));
    const scrolledInset = await more.evaluate((menu) => {
      const row = menu.closest('[role="group"]');
      return row.getBoundingClientRect().right - menu.getBoundingClientRect().right;
    });
    assert(Math.abs(scrolledInset - mobile.rightInset) <= 1);
    await page.screenshot({ path: join(evidence, `after-mobile-${theme}.png`), animations: 'disabled' });
    await more.focus();
    assert.equal(await more.evaluate((el) => document.activeElement === el), true);
    await more.selectOption(extraAsk);
    await queue.locator(`[data-queue-ask="${extraAsk}"]`).waitFor();
    observation.mobile = mobile;
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  writeFileSync(join(evidence, 'human-queue-web.json'), JSON.stringify(observations, null, 2));
  await browser.close();
}
if (phase === 'before') {
  const failures = observations.flatMap(({ theme, rows, hover }) => {
    assert.equal(rows.standalone, 1);
    assert.deepEqual(hover.face, [44, 44]);
    return [`${theme}: a duplicate standalone filter row and a 44 px hover face`];
  });
  assert.fail(failures.join('\n'));
}
if (phase === 'layout-before') {
  for (const { filters } of observations) {
    assert(filters.gap >= 20);
    assert(filters.askHeight > 34);
    assert(filters.moreWidth > 34);
  }
  assert.fail(`${observations.length} themes: extra header gap and a wrapping text More control`);
}
if (phase === 'topic-before') {
  for (const { savedTopic } of observations)
    assert.deepEqual(savedTopic, { state: 'In progress 1', badgeDisabled: false });
  assert.fail(`${observations.length} themes: the saved topic silently narrowed In progress to 1`);
}
console.log(`PASS: ${observations.length} themes, state and ask filters, Hold and Take back, and centered attachment hover`);
