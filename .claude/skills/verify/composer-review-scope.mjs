import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run] = process.argv.slice(2);
assert(port && !['8399', '8499'].includes(port));
const rpc = (name, input = {}) => JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { encoding: 'utf8' })).reply;
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const receipts = [];
let page;
try {
  const base = `http://127.0.0.1:${port}`;
  const pair = await browser.newContext();
  const made = rpc('device.pair.create', { kind: 'human' });
  assert.equal((await pair.request.post(`${base}/pair`, { headers: { origin: base }, data: { code: made.code, name: 'Synthetic scope browser' } })).status(), 200);
  const storageState = await pair.storageState();
  await pair.close();
  const session = rpc('rpc:session.create', { workspacePath: `${run}/home`, title: 'Classic recording proof', config: { queryMode: 'manual' } });
  assert(session.sessionId, JSON.stringify(session));
  for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, hasTouch: width === 390, permissions: ['microphone'] });
    await context.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    page = await context.newPage();
    await page.goto(`${base}/session/${session.sessionId}`);
    await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
    const bars = page.getByTestId('voice-bars');
    await bars.locator('div').first().waitFor();
    assert.equal(await bars.evaluate(el => el.closest('.neo-shell') === null), true);
    assert.equal(await bars.locator('div').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 59, 48)');
    const cancel = page.getByRole('button', { name: 'Cancel recording', exact: true });
    assert.equal((await cancel.boundingBox()).width, 36);
    assert.notEqual(await cancel.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    const initialTimer = await page.getByTestId('voice-timer').innerText();
    await page.waitForFunction(initial => document.querySelector('[data-testid=voice-timer]')?.textContent !== initial, initialTimer);
    await page.getByRole('button', { name: 'Stop recording and transcribe', exact: true }).click();
    const status = page.getByTestId('voice-transcribing');
    await status.waitFor();
    assert.equal(await bars.isVisible(), true);
    assert.equal(await status.locator('.animate-spin').count(), 1);
    await page.screenshot({ path: `${run}/evidence/classic-${theme}-${width}.png` });
    await page.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
    receipts.push({ surface: 'classic', theme, width, redBars: true, filledCancel: true, inlineSpinner: true });
    await context.close();
  }
  assert(rpc('rpc:settings.global.update', { updates: { language: 'zh-Hans' } }).success);
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, hasTouch: width === 390, permissions: ['microphone'], locale: 'zh-CN' });
    page = await context.newPage();
    await page.goto(`${base}/neo`);
    await page.locator('#neo-thought').fill('Synthetic localized preview.');
    await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
    await page.getByTestId('voice-recording-draft').getByText('Preview transcript.', { exact: true }).waitFor();
    const initialTimer = await page.getByTestId('voice-timer').innerText();
    await page.waitForFunction(initial => document.querySelector('[data-testid=voice-timer]')?.textContent !== initial, initialTimer);
    await page.getByRole('button', { name: 'Stop recording and keep the text as a draft', exact: true }).click();
    const status = page.getByTestId('voice-transcribing');
    await status.waitFor();
    assert.equal(await status.innerText(), '正在转写…');
    await page.screenshot({ path: `${run}/evidence/neo-zh-${width}.png` });
    await page.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
    receipts.push({ surface: 'neo', width, localized: true });
    await context.close();
  }
  console.log(`PASS: ${receipts.length} classic/localized UI cases`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: `${run}/evidence/scope-failure.png` });
    writeFileSync(`${run}/evidence/scope-failure.txt`, await page.locator('body').innerText());
  }
  throw error;
} finally {
  writeFileSync(`${run}/evidence/review-scope.json`, JSON.stringify(receipts, null, 2));
  await browser.close();
}
