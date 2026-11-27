import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [port, directory, phase] = process.argv.slice(2);
assert(port && port !== '8399' && directory && ['before', 'topic-before', 'layout-before', 'after', 'short-topics', 'late-reference', 'waiting-only', 'phone-parity'].includes(phase));
const run = resolve(directory);
const evidence = join(run, 'evidence');
const base = `http://127.0.0.1:${port}`;
const pair = JSON.parse(execFileSync('bun', [
  '.claude/skills/verify/rpc.ts', 'device.pair.create', '{"kind":"human"}',
], { encoding: 'utf8' })).reply;
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observations = [];
async function checkLateReference(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  let hideHeldCard = true;
  await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const response = JSON.parse(String(message));
      const queue = response.data?.humanQueue;
      if (hideHeldCard && queue) {
        queue.items = queue.items.filter((item) => item.questionId !== 'trip-card');
        queue.counts.trip.held = 0;
        socket.send(JSON.stringify(response));
      } else {
        socket.send(message);
      }
    });
  });
  await page.goto(`${base}/neo`);
  const queue = page.locator('[data-human-queue]');
  await queue.getByRole('button', { name: 'Finance 2', exact: true }).click();
  await page.getByRole('button', { name: /I replied · View card/ }).click();
  await page.locator('[data-ask="trip"]').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Back to chat', exact: true }).count(), 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await queue.getByRole('button', { name: 'Held 0' }).getAttribute('aria-pressed'), 'false');
  hideHeldCard = false;
  const { reply } = JSON.parse(execFileSync('bun', [
    '.claude/skills/verify/rpc.ts', 'neo.question.hold',
    JSON.stringify({ questionId: 'budget-card', held: true, requestId: randomUUID() }),
  ], { encoding: 'utf8' }));
  assert.equal(reply.ok, true);
  const held = queue.getByRole('button', { name: 'Held 2' });
  await held.waitFor();
  const result = { heldSelected: false, target: 'neo-ref-question-trip-card' };
  try {
    await queue.getByRole('button', { name: 'Held 2', pressed: true }).waitFor({ timeout: 2000 });
    result.heldSelected = true;
    await page.waitForFunction(id => document.activeElement?.id === id, result.target, { timeout: 5000 });
  } finally {
    await page.screenshot({ path: join(evidence, 'late-reference.png'), animations: 'disabled' });
    observations.push(result);
  }
}
async function checkWaitingOnly(context, theme) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${base}/neo`);
  const scenes = page.getByRole('region', { name: 'Work scenes' });
  const queue = page.locator('[data-human-queue]');
  await queue.locator('#neo-ref-question-hotel-card').getByRole('button', { name: 'Hold', exact: true }).waitFor();
  const shown = async () => ({
    sections: await scenes.locator('[data-scene-group]').evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-label'))),
    heldCard: await scenes.locator('#neo-ref-question-trip-card').count(),
    uncoveredTodo: await scenes.getByText('Pack the bags', { exact: true }).count(),
    finished: await scenes.getByText('Synthetic filed archive', { exact: true }).count(),
  });
  const waiting = await shown();
  await page.screenshot({ path: join(evidence, `waiting-only-${theme}.png`), animations: 'disabled' });
  await queue.getByRole('button', { name: /^In progress / }).click();
  await queue.getByText('Pack the bags', { exact: true }).first().waitFor();
  await scenes.getByText('Synthetic filed archive', { exact: true }).waitFor({ timeout: 5000 }).catch(() => {});
  const progress = await shown();
  await page.screenshot({ path: join(evidence, `waiting-only-progress-${theme}.png`), animations: 'disabled' });
  observations.push({ theme, waiting, progress });
}
async function checkPhoneParity(context, theme) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${base}/neo`);
  const queue = page.locator('[data-human-queue]');
  const states = queue.getByRole('group', { name: '状态' });
  await states.waitFor();
  const chips = await states.getByRole('button').allInnerTexts();
  await page.screenshot({ path: join(evidence, `phone-parity-waiting-${theme}.png`), animations: 'disabled' });
  const tab = async (name) => {
    const chip = states.getByRole('button', { name: new RegExp(`^${name}`) });
    if (!(await chip.count())) return false;
    await chip.click();
    return true;
  };
  await tab('进行中|在做');
  const progress = await queue.locator('[data-ask-todo]').count();
  const allWork = await tab('所有工作');
  if (!allWork) await tab('进行中|在做');
  const big = page.locator('[data-ask="big"] [data-ask-status]').first();
  const card = (await big.count()) ? await big.innerText() : null;
  const filed = () => page.locator('[data-ask^="filed-"]').count();
  const before = await filed();
  const older = page.getByRole('button', { name: '显示更早的结果' });
  const offered = await older.count();
  if (offered) {
    await older.click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-ask^="filed-"]').length > n, before, { timeout: 5000 }).catch(() => {});
  }
  const after = await filed();
  await page.screenshot({ path: join(evidence, `phone-parity-all-${theme}.png`), animations: 'disabled', fullPage: true });
  observations.push({ theme, chips, progress, allWork, card, older: { offered, before, after } });
}
async function checkShortTopics(context, theme) {
  await context.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (message) {
      const request = typeof message === 'string' ? JSON.parse(message) : null;
      if (['neo.open', 'neo.snapshot'].includes(request?.data?.name)) {
        request.data.name = 'neo.snapshot';
        request.data.input.projectId = 'payments';
        document.documentElement.dataset.topicProofScoped = '1';
        message = JSON.stringify(request);
      }
      if (request?.data?.name === 'neo.ask.read' && request.data.input.askId === 'pay-sender')
        document.documentElement.dataset.topicProofLoadedSender = '1';
      send.call(this, message);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  const loaded = await page.goto(`${base}/neo`);
  assert.equal(loaded?.status(), 200);
  const queue = page.locator('[data-human-queue]');
  const topicRow = queue.getByRole('group', { name: '主题' });
  const more = topicRow.getByRole('combobox', { name: '更多' });
  const all = topicRow.getByRole('button', { name: '全部 8' });
  const payments = topicRow.getByRole('button', { name: '支付 2' });
  const cards = async (...ids) => {
    for (const id of ids) await queue.locator(`[data-ask="${id}"]`).waitFor();
    assert.deepEqual((await queue.locator('article[data-ask]').evaluateAll(
      (items) => items.map((item) => item.dataset.ask)
    )).sort(), ids.sort());
  };
  try {
    await payments.waitFor();
  } catch (error) {
    observations.push({ theme, errors, url: page.url() });
    await page.screenshot({ path: join(evidence, `short-topics-failure-${theme}.png`), timeout: 2500 }).catch(() => {});
    throw error;
  }
  assert.equal(await page.locator('html').getAttribute('data-topic-proof-scoped'), '1');
  assert.deepEqual(await topicRow.getByRole('button').allInnerTexts(), ['全部 8', '支付 2', 'HyperNeo 1', 'API 1']);
  const options = await more.locator('option').allInnerTexts();
  assert.deepEqual(options, ['更多', '甲乙丙丁戊… 1', '甲乙丙丁戊… 1', '项目 1', '其他 1']);
  for (const id of ['long-a', 'long-b']) {
    await more.selectOption(id);
    await cards(id);
  }
  await more.selectOption('pick:其他');
  await cards('legacy');
  await all.click();
  await queue.locator('[data-ask="legacy"]').waitFor();
  await payments.click();
  await cards('pay-primary', 'pay-sender');
  assert.equal(await page.locator('html').getAttribute('data-topic-proof-loaded-sender'), '1');
  assert.equal(await queue.locator('[data-ask="pay-sender"] [data-topic-swatch]').innerText(), '支付');
  assert.equal((await queue.locator('[data-ask="pay-sender"] h3').innerText()).trim().length, 120);
  await page.screenshot({ path: join(evidence, `short-topics-waiting-${theme}.png`), animations: 'disabled' });
  const moveQuestions = async (prefix, button) => {
    for (const id of ['pay-primary', 'pay-sender'])
      await queue.locator(`#neo-ref-question-${prefix}-${id}`).getByRole('button', { name: button }).click();
  };
  await moveQuestions('waiting', '先放着');
  await queue.getByRole('button', { name: '先放着 4' }).click();
  await moveQuestions('held', '拿回来');
  await queue.getByRole('button', { name: '先放着 2' }).waitFor();
  assert.equal(await more.locator('option[value="payments"]').innerText(), '支付 2');
  await more.selectOption('payments');
  await cards('pay-primary', 'pay-sender');
  await page.screenshot({ path: join(evidence, `short-topics-held-${theme}.png`), animations: 'disabled' });
  assert.deepEqual(errors, []);
  observations.push({ theme, scoped: true, options, payments: '支付 2', selectedAsks: 2 });
}
try {
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, {
    headers: { origin: base }, data: { code: pair.code, name: 'Synthetic Inbox browser' },
  });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const themes = phase === 'short-topics' ? [process.env.VERIFY_THEME ?? 'light'] :
    phase === 'late-reference' ? ['light'] : ['light', 'dark'];
  for (const theme of themes) {
    assert(['light', 'dark'].includes(theme));
    const context = await browser.newContext({ storageState, viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: ['short-topics', 'phone-parity'].includes(phase) ? 'zh-CN' : 'en-US' });
    await context.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
    await context.addInitScript((value) => localStorage.setItem('theme', value), theme);
    if (phase === 'late-reference') {
      await checkLateReference(context);
      await context.close();
      continue;
    }
    if (phase === 'phone-parity') {
      await checkPhoneParity(context, theme);
      await context.close();
      continue;
    }
    if (phase === 'waiting-only') {
      await checkWaitingOnly(context, theme);
      await context.close();
      continue;
    }
    if (phase === 'short-topics') {
      await checkShortTopics(context, theme);
      await context.close();
      continue;
    }
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
    const asks = queue.getByRole('group', { name: phase === 'after' ? 'Topic' : 'Ask', exact: true });
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
    const extraTopic = await more.locator('option').last().getAttribute('value');
    assert(extraTopic);
    const extraAsk = { 'pick:travel': 'trip', 'pick:finance': 'tax', 'pick:railtickets': 'tickets', 'pick:budgetplans': 'budget' }[extraTopic];
    assert(extraAsk);
    await more.selectOption(extraTopic);
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
    await asks.getByRole('button', { name: 'Finance 1' }).click();
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
    await more.selectOption(extraTopic);
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
if (phase === 'waiting-only') {
  const leaks = observations.filter(({ waiting }) =>
    waiting.sections.length || waiting.heldCard || waiting.uncoveredTodo || waiting.finished);
  assert.deepEqual(leaks, [], `Waiting on you lists work that is not waiting: ${JSON.stringify(leaks)}`);
  for (const { progress } of observations) {
    assert(progress.sections.includes('Recent outcomes'));
    assert.equal(progress.finished, 1);
  }
}
if (phase === 'phone-parity') {
  const wrong = observations.filter((seen) =>
    JSON.stringify(seen.chips) !== JSON.stringify(['等你 0', '已搁置 0', '进行中 0', '所有工作 5']) ||
    seen.progress !== 0 || !seen.allWork || !seen.card?.includes('· 2 个待办') ||
    !seen.older.offered || seen.older.after <= seen.older.before);
  assert.deepEqual(wrong, [], `The web Inbox differs from the phone: ${JSON.stringify(wrong)}`);
}
if (phase === 'topic-before') {
  for (const { savedTopic } of observations)
    assert.deepEqual(savedTopic, { state: 'In progress 1', badgeDisabled: false });
  assert.fail(`${observations.length} themes: the saved topic silently narrowed In progress to 1`);
}
console.log(`PASS: ${observations.length} themes, ${phase === 'late-reference' ? 'late queue reference selects Held and receives focus' : phase === 'waiting-only' ? 'Waiting on you lists only waiting cards; In progress keeps recent outcomes' : phase === 'short-topics' ? 'localized topic chips, overflow and grouped queue cards' : 'state and topic filters, Hold and Take back, and centered attachment hover'}`);
