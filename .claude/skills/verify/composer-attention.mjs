import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run, executablePath, modulePath, code, phase = 'after'] = process.argv.slice(2);
assert(!['8399', '8499'].includes(port));
const before = phase === 'before';
const base = `http://127.0.0.1:${port}`;
const { chromium } = createRequire(import.meta.url)(modulePath || 'playwright');
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const observed = [];
try {
  const pairing = await browser.newContext();
  assert.equal((await pairing.request.post(`${base}/pair`, { headers: { origin: base }, data: { code, name: 'Synthetic action browser' } })).status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, hasTouch: width === 390, locale: 'en-US' });
    await context.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    const page = await context.newPage();
    try {
      await page.goto(`${base}/neo`);
      if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
      const card = page.locator('[data-ask="composer-fixture"]:visible');
      await card.locator('[data-question-source]').getByRole('button', { name: 'Open session: Synthetic worker', exact: true }).click();
      const pane = page.locator('.neo-session-pane');
      const input = pane.getByRole('textbox', { name: 'Message this chat', exact: true });
      await input.waitFor();
      const form = pane.locator('form.neo-composer-input');
      const screenshot = async name => {
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
        });
        const box = await form.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1, 'composer must fit the visible pane');
        await page.screenshot({ path: `${run}/evidence/${phase}-${theme}-${width}-${name}.png` });
      };
      const state = async mode => assert.equal((await page.request.post(`${base}/fixture`, { headers: { origin: base }, data: { state: mode } })).status(), 200);
      const send = form.getByRole('button', { name: 'Send message', exact: true });
      const stop = form.getByRole('button', { name: 'Stop', exact: true });
      await state('working');
      await stop.waitFor();
      await input.focus();
      assert.equal(await send.count(), before ? 1 : 0);
      await screenshot('empty-turn');
      await input.fill('A new draft while the turn runs');
      assert.equal(await stop.count(), before ? 1 : 0);
      assert.equal(await send.isEnabled(), true);
      await screenshot('draft-turn');
      await input.fill('');
      await input.evaluate(el => el.blur());
      await stop.waitFor();
      await stop.click();
      await stop.waitFor({ state: 'hidden' });
      await input.evaluate(el => el.blur());
      await state('waiting');
      await page.waitForFunction(expected => document.querySelector('.neo-session-pane .neo-composer-input')?.classList.contains('is-collapsed') === expected, !before);
      assert.equal(await send.count(), before ? 1 : 0);
      await screenshot('question');
      await state('error');
      await form.getByText('needs you', { exact: true }).waitFor();
      assert.equal(await send.count(), 1);
      await screenshot('error');
      await state('idle');
      await page.waitForFunction(() => document.querySelector('.neo-session-pane .neo-composer-input.is-collapsed'));
      observed.push({ theme, width, phase, sharedSlot: !before, questionCollapsed: !before, errorStillVisible: true });
    } catch (error) {
      await page.screenshot({ path: `${run}/evidence/attention-failure.png` });
      writeFileSync(`${run}/evidence/attention-failure.txt`, await page.locator('body').innerText());
      throw error;
    } finally { await context.close(); }
  }
  console.log(`PASS: ${observed.length} ${phase} action-slot/question layouts`);
} finally {
  writeFileSync(`${run}/evidence/attention.json`, JSON.stringify(observed, null, 2));
  await browser.close();
}
