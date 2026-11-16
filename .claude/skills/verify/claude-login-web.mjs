import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

const HOLD_LINE = 'Claude needs you to sign in again · Sign in';

export async function verifyClaudeLogin(page, run) {
  const { port, sessionId, historicalResult } = JSON.parse(await readFile(`${run}/evidence/observed.json`, 'utf8'));
  assert.notEqual(port, 8399);
  const surfaces = [['neo', '/neo'], ['session', `/session/${sessionId}`]];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [surface, path] of surfaces) {
      await page.goto(`http://127.0.0.1:${port}${path}`);
      const notice = page.getByText('Claude login failed — sign in again', { exact: true }).first();
      const line = page.locator('[data-model-hold="login"]').first();
      await line.waitFor();
      assert.equal((await line.textContent())?.trim(), HOLD_LINE);
      assert.equal(await notice.count(), 0, 'a login hold must not read as a failed login');
      assert.equal(await page.getByText(/Rate limit reached\./).count(), 0, 'no bottom banner for a login hold');
      await line.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: `${run}/evidence/${surface}-${width}.png`, animations: 'disabled' });
      const box = await line.boundingBox();
      const top = Math.max(0, Math.floor(box.y) - 24);
      await page.screenshot({ path: `${run}/evidence/${surface}-${width}-line.png`, animations: 'disabled', clip: { x: 0, y: top, width, height: 1000 - top } });
      if (surface === 'session' && historicalResult) {
        await page.getByRole('button', { name: /tokens/ }).last().click();
        const failure = page.getByText(historicalResult, { exact: true });
        await failure.waitFor();
        await failure.scrollIntoViewIfNeeded();
        assert(await failure.evaluate(el => el.className.includes('text-danger')));
        await page.screenshot({ path: `${run}/evidence/session-result-error-${width}.png`, animations: 'disabled' });
      }
    }
  }
  const accepts = existsSync(`${run}/evidence/accepts-key`);
  if (accepts) {
    await writeFile(`${run}/browser-held`, 'held');
    for (let i = 0; i < 600 && !existsSync(`${run}/key-accepted`); i += 1) await page.waitForTimeout(100);
    assert(existsSync(`${run}/key-accepted`), 'the new key was not accepted');
    await page.setViewportSize({ width: 1280, height: 1000 });
    for (const [surface, path] of surfaces) {
      await page.goto(`http://127.0.0.1:${port}${path}`);
      await page.waitForTimeout(1500);
      assert.equal(await page.locator('[data-model-hold]').count(), 0, `${surface} still shows the hold`);
      await page.screenshot({ path: `${run}/evidence/${surface}-after-key-1280.png`, animations: 'disabled' });
    }
  }
  await writeFile(`${run}/evidence/browser.json`, JSON.stringify({ passed: true, widths: [1280, 390], hold: HOLD_LINE, loginNotice: false, clearedAfterKey: accepts }, null, 2));
  await writeFile(`${run}/browser-done`, 'done');
}
