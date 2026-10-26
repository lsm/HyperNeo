import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const evidence = { observations: [], screenshotsCaptured: false };
let browser;
let page;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  page = await browser.newPage({ locale: 'en-US', permissions: ['microphone'] });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
    await input.waitFor();
    const form = page.locator('form.neo-composer-input');
    const attach = form.getByRole('button', { name: 'Attach photos or files', exact: true });
    const mic = form.getByRole('button', { name: 'Start voice input', exact: true });
    const send = form.getByRole('button', { name: 'Send message', exact: true });
    await mic.waitFor();
    const bounds = async (locator) => {
      const box = await locator.boundingBox();
      assert(box);
      return box;
    };
    const collapsed = await bounds(form);
    await page.screenshot({ path: `${run}/evidence/composer-${width}-collapsed.png` });
    const a = await bounds(attach), m = await bounds(mic);
    assert.equal(await send.count(), 0, 'empty unfocused capsule must have no send button');
    assert(Math.abs(a.y - m.y) < 5 && a.x < m.x);
    assert(m.height >= 44 && a.height >= 44);
    assert(collapsed.height >= 46 && collapsed.height <= 50, `capsule must be about 48px tall: ${collapsed.height}`);
    const column = await form.evaluate(el => {
      const parent = el.parentElement, style = getComputedStyle(parent);
      return { x: parent.getBoundingClientRect().x + parseFloat(style.paddingLeft), width: parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    });
    const proportion = collapsed.width / column.width;
    assert(proportion >= 0.81 && proportion <= 0.85, `capsule width must be about 83%: ${proportion}`);
    assert(Math.abs(collapsed.x + collapsed.width / 2 - column.x - column.width / 2) <= 1, 'capsule must be centered');
    const radius = await form.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius));
    assert(radius >= collapsed.height / 2, 'ends must be fully semicircular');
    assert(collapsed.x >= 0 && collapsed.x + collapsed.width <= width + 1);
    await page.screenshot({ path: `${run}/evidence/composer-${width}-collapsed.png` });
    const choosing = page.waitForEvent('filechooser');
    await attach.click();
    await (await choosing).setFiles([]);
    await attach.focus();
    await send.waitFor();
    assert((await bounds(form)).height > collapsed.height, 'control focus must expand');
    await input.fill('First line\nSecond line');
    assert((await bounds(form)).height > collapsed.height);
    await form.getByRole('button', { name: 'Model and thinking', exact: true }).waitFor();
    await page.screenshot({ path: `${run}/evidence/composer-${width}-focused.png` });
    await input.evaluate((el) => el.blur());
    assert.equal(await input.inputValue(), 'First line\nSecond line');
    assert((await bounds(form)).height > collapsed.height, 'blurred draft must stay expanded');
    await page.screenshot({ path: `${run}/evidence/composer-${width}-blurred-draft.png` });
    await send.waitFor();
    await input.fill('');
    await input.evaluate((el) => el.blur());
    assert.equal(await send.count(), 0);
    assert.equal((await bounds(form)).height, collapsed.height);
    await mic.click();
    const stop = form.getByRole('button', { name: 'Stop recording and keep the text as a draft', exact: true });
    await stop.waitFor();
    const sendRecording = form.getByRole('button', { name: 'Stop recording and send the message', exact: true });
    await page.waitForFunction(() => document.querySelector('form.neo-composer-input.is-recording:not(.is-collapsed)'));
    await sendRecording.waitFor();
    const [r, rs] = await form.evaluate(el => [
      el.querySelector('[aria-label="Stop recording and keep the text as a draft"]'),
      el.querySelector('[aria-label="Stop recording and send the message"]'),
    ].map(button => { const box = button.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; }));
    evidence.recording = { stop: r, send: rs, gap: rs.x - r.x - r.width };
    assert(rs.x - (r.x + r.width) >= 15.5, `recording gap must be 16px: ${rs.x - r.x - r.width}`);
    await page.screenshot({ path: `${run}/evidence/composer-${width}-recording.png` });
    evidence.observations.push({ width, collapsed, proportion, radius, recordingGap: rs.x - r.x - r.width, draftPreserved: true });
    await form.getByRole('button', { name: /Cancel recording/ }).click();
  }
  const disabled = JSON.parse(execFileSync('bun', [new URL('./rpc.ts', import.meta.url).pathname, 'rpc:settings.global.update', JSON.stringify({ updates: { voice: { enabled: false } } })], { env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8' }));
  assert.equal(disabled.reply.success, true);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload();
  const noVoice = page.locator('.neo-composer-input');
  await noVoice.getByRole('textbox', { name: 'Message Neo', exact: true }).waitFor();
  assert.equal(await noVoice.getByRole('button', { name: 'Start voice input', exact: true }).count(), 0);
  assert.equal(await noVoice.getByRole('button', { name: 'Send message', exact: true }).count(), 0);
  await noVoice.getByRole('button', { name: 'Attach photos or files', exact: true }).waitFor();
  await page.screenshot({ path: `${run}/evidence/composer-390-no-voice.png` });
  evidence.voiceDisabledVerified = true;
  evidence.screenshotsCaptured = true;
} catch (error) {
  evidence.error = String(error);
  if (page) {
    evidence.errorControls = await page.locator('form.neo-composer-input').innerText().catch(() => 'no composer');
    await page.screenshot({ path: `${run}/evidence/composer-error.png` }).catch(() => {});
  }
  throw error;
} finally {
  writeFileSync(`${run}/evidence/composer-layout.json`, JSON.stringify(evidence, null, 2));
  await browser?.close();
}
