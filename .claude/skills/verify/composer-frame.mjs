import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run] = process.argv.slice(2);
assert(port && !['8399', '8499'].includes(port));
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const observations = [];
const before = process.env.VERIFY_COMPOSER_PHASE === 'before';
try {
  const made = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', '{"kind":"human"}'], { encoding: 'utf8' })).reply;
  const pairing = await browser.newContext();
  const response = await pairing.request.post(`${base}/pair`, { headers: { origin: base }, data: { code: made.code, name: 'Synthetic composer browser' } });
  assert.equal(response.status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, hasTouch: width === 390, permissions: ['microphone'] });
    await context.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => console.error(String(error)));
    await page.goto(`${base}/neo`);
    const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
    await input.waitFor();
    const form = page.locator('form.neo-composer-input');
    const sample = () => form.evaluate(el => {
      const style = getComputedStyle(el);
      const color = token => {
        const probe = document.createElement('span');
        probe.style.color = `var(${token})`; el.append(probe);
        const value = getComputedStyle(probe).color; probe.remove(); return value;
      };
      return { border: style.borderTopColor, shadow: style.boxShadow,
        send: color('--neo-send'), sendFg: color('--neo-send-fg'), control: color('--control-fill'), danger: color('--danger'),
        width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
    });
    await page.waitForFunction(() => document.querySelector('.neo-composer-input.is-collapsed'));
    const collapsed = await sample();
    assert.equal(await input.evaluate(el => getComputedStyle(el).paddingLeft), '0px');
    assert.equal(collapsed.border, theme === 'light' ? 'rgb(200, 203, 209)' : 'rgb(81, 84, 94)');
    assert(collapsed.height >= 46 && collapsed.height <= 50);
    await form.screenshot({ path: `${run}/evidence/${theme}-${width}-collapsed.png` });
    await input.focus();
    const send = form.getByRole('button', { name: 'Send message', exact: true });
    assert.equal(await send.isDisabled(), !before);
    assert.equal(await send.evaluate(el => getComputedStyle(el).opacity), '1');
    await form.screenshot({ path: `${run}/evidence/${theme}-${width}-empty-focused.png` });
    await input.fill('Synthetic draft');
    await page.waitForTimeout(200);
    const focused = await sample();
    assert.equal(await send.isEnabled(), true);
    const geometry = await send.evaluate(el => {
      const face = el.firstElementChild;
      return { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
        faceWidth: face.getBoundingClientRect().width, faceHeight: face.getBoundingClientRect().height,
        radius: getComputedStyle(face).borderRadius, color: getComputedStyle(face).backgroundColor };
    });
    if (!before) {
    assert.equal(geometry.width, 44); assert.equal(geometry.height, 44);
    assert.equal(geometry.faceWidth, 44); assert.equal(geometry.faceHeight, 32);
    assert.equal(geometry.radius, '10px'); assert.equal(geometry.color, focused.send);
    const pill = form.getByRole('button', { name: 'Model and thinking', exact: true });
    assert.equal(await pill.evaluate(el => getComputedStyle(el).backgroundColor), focused.control);
    assert.equal(await pill.evaluate(el => getComputedStyle(el).fontSize), '14px');
    assert.equal((await pill.boundingBox()).height, 32);
    }
    assert.notEqual(focused.border, 'rgba(0, 0, 0, 0)');
    if (!before) assert(focused.shadow.includes('0.12') && focused.shadow.includes('32px'));
    await form.screenshot({ path: `${run}/evidence/${theme}-${width}-focused.png` });
    await input.evaluate(el => el.blur());
    await page.waitForTimeout(200);
    const blurred = await sample();
    assert.equal(blurred.border, before ? collapsed.border : 'rgba(0, 0, 0, 0)');
    assert.equal(await input.inputValue(), 'Synthetic draft');
    if (!before) {
    assert.equal(blurred.send, theme === 'light' ? 'rgb(184, 124, 92)' : 'rgb(239, 194, 166)');
    assert.equal(blurred.sendFg, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(37, 39, 44)');
    assert.equal(blurred.control, theme === 'light' ? 'rgb(235, 236, 239)' : 'rgb(46, 49, 57)');
    assert.equal(blurred.danger, theme === 'light' ? 'rgb(197, 48, 48)' : 'rgb(242, 139, 130)');
    }
    await form.screenshot({ path: `${run}/evidence/${theme}-${width}-blurred.png` });
    await page.screenshot({ path: `${run}/evidence/${theme}-${width}-context.png` });
    await input.fill(''); await input.evaluate(el => el.blur());
    await form.getByRole('button', { name: 'Start voice input', exact: true }).click();
    await form.getByRole('button', { name: 'Cancel recording', exact: true }).waitFor();
    await page.locator('.neo-composer-input.is-recording').waitFor();
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(200);
    const recording = await sample();
    assert.notEqual(recording.border, 'rgba(0, 0, 0, 0)');
    if (!before) assert.equal(recording.border, focused.border);
    if (!before) assert(recording.shadow.includes('0.12') && recording.shadow.includes('32px'));
    await form.screenshot({ path: `${run}/evidence/${theme}-${width}-recording.png` });
    await form.getByRole('button', { name: 'Cancel recording', exact: true }).click();
    observations.push({ theme, width, collapsed, focused, blurred, recording, geometry });
    await page.goto(`${base}/assets/composer-insets.html`);
    const fixture = page.locator('form.neo-composer-input');
    await fixture.waitFor().catch(async error => { await page.screenshot({ path: `${run}/evidence/fixture-error.png` }); throw error; });
    await fixture.locator('input[type=file]').setInputFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic pending read') });
    const reading = fixture.getByRole('status').filter({ hasText: /Reading/ });
    await reading.waitFor();
    const rows = [fixture.getByRole('region'), fixture.getByRole('status').filter({ hasText: /Bound preview/ }).locator('..'),
      fixture.getByRole('button', { name: /Use current Preview/ }), reading];
    const insetReceipts = [];
    for (const row of rows) {
      const inset = await row.evaluate(el => {
        const form = el.closest('form');
        return el.getBoundingClientRect().x - form.getBoundingClientRect().x + parseFloat(getComputedStyle(el).paddingLeft);
      });
      insetReceipts.push(inset);
    }
    await fixture.screenshot({ path: `${run}/evidence/${theme}-${width}-auxiliary.png` });
    assert(insetReceipts.every(value => Math.abs(value - 17) <= 1), `All auxiliary row content must retain 17px frame inset: ${insetReceipts}`);
    observations.at(-1).insets = insetReceipts;
    await context.close();
  }
  writeFileSync(`${run}/evidence/composer-frame.json`, JSON.stringify({ phase: before ? 'before' : 'after', passed: true, observations }, null, 2));
  console.log('PASS: composer frame and tokens in both themes at 390/1280; idle capsule preserved; synthetic recording cancelled');
} finally { await browser.close(); }
