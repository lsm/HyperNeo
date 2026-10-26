import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const evidence = { observations: [], screenshotsVerified: false };
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage({ locale: 'en-US', permissions: ['microphone'] });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
    await input.waitFor();
    const form = input.locator('..');
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
    await input.fill('First line\nSecond line');
    assert((await bounds(form)).height > collapsed.height);
    await form.getByRole('button', { name: 'Model and thinking', exact: true }).waitFor();
    await page.screenshot({ path: `${run}/evidence/composer-${width}-focused.png` });
    await input.evaluate((el) => el.blur());
    assert.equal(await input.inputValue(), 'First line\nSecond line');
    assert((await bounds(form)).height > collapsed.height, 'blurred draft must stay expanded');
    await send.waitFor();
    await input.fill('');
    await input.evaluate((el) => el.blur());
    assert.equal(await send.count(), 0);
    assert.equal((await bounds(form)).height, collapsed.height);
    await mic.click();
    const stop = form.getByRole('button', { name: 'Stop recording and keep the text as a draft', exact: true });
    await stop.waitFor();
    const sendRecording = form.getByRole('button', { name: 'Stop recording and send the message', exact: true });
    const r = await bounds(stop), rs = await bounds(sendRecording);
    assert(rs.x - (r.x + r.width) >= 16);
    await page.screenshot({ path: `${run}/evidence/composer-${width}-recording.png` });
    evidence.observations.push({ width, collapsed, proportion, radius, recordingGap: rs.x - r.x - r.width, draftPreserved: true });
    await form.getByRole('button', { name: /Cancel recording/ }).click();
  }
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  writeFileSync(`${run}/evidence/composer-layout.json`, JSON.stringify(evidence, null, 2));
  await browser?.close();
}
