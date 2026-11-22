import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [port, directory, phase] = process.argv.slice(2);
assert(port && port !== '8399' && directory && ['before', 'after'].includes(phase));
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
    const states = queue.getByRole('group', { name: 'State', exact: true });
    const asks = queue.getByRole('group', { name: 'Ask', exact: true });
    const more = asks.getByRole('combobox', { name: 'More' });
    const rows = {
      standalone: await chips.count(),
      state: await states.getByRole('button').allInnerTexts(),
      ask: await asks.getByRole('button').allInnerTexts(),
      more: await more.count(),
    };
    await page.screenshot({ path: join(evidence, `${phase}-${theme}.png`), animations: 'disabled' });
    observations.push({ theme, rows, hover });
    assert.deepEqual(rows.state, ['Waiting on you 4', 'Held 1', 'In progress 2']);
    assert.equal(rows.ask[0], 'All 4');
    assert.equal(rows.more, 1);
    assert.deepEqual(hover.target, [44, 44]);
    assert.notEqual(hover.background, 'rgba(0, 0, 0, 0)');
    if (phase === 'before') continue;
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
console.log(`PASS: ${observations.length} themes, state and ask filters, Hold and Take back, and centered attachment hover`);
