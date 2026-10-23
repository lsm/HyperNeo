import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

export async function verifyClaudeLogin(page, run) {
  const { port, sessionId, historicalResult } = JSON.parse(await readFile(`${run}/evidence/observed.json`, 'utf8'));
  assert.notEqual(port, 8399);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [surface, path] of [['neo', '/neo'], ['session', `/session/${sessionId}`]]) {
      await page.goto(`http://127.0.0.1:${port}${path}`);
      const notice = page.getByText('Claude login failed — sign in again', { exact: true }).first();
      await notice.waitFor();
      if (surface === 'neo') await page.getByRole('status').filter({ hasText: 'needs you' }).waitFor();
      await notice.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.screenshot({ path: `${run}/evidence/${surface}-${width}.png`, animations: 'disabled' });
      if (surface === 'session' && historicalResult) {
        await page.getByRole('button', { name: 'more — Result details', exact: true }).click();
        const failure = page.getByText(historicalResult, { exact: true });
        await failure.waitFor();
        await failure.scrollIntoViewIfNeeded();
        assert(await failure.evaluate(el => el.className.includes('text-danger')));
        await page.screenshot({ path: `${run}/evidence/session-result-error-${width}.png`, animations: 'disabled' });
      }

    }
  }
  await writeFile(`${run}/evidence/browser.json`, JSON.stringify({ passed: true, widths: [1280,390], notice: 'Claude login failed — sign in again', neoStatus: 'needs you' },null,2));
  await writeFile(`${run}/browser-done`, 'done');
}
