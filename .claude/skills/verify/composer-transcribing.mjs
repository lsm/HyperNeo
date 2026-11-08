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
let currentPage;
try {
  const base = `http://127.0.0.1:${port}`;
  const pair = await browser.newContext();
  const made = rpc('device.pair.create', { kind: 'human' });
  assert.equal((await pair.request.post(`${base}/pair`, { headers: { origin: base }, data: { code: made.code, name: 'Synthetic transcription browser' } })).status(), 200);
  const storageState = await pair.storageState();
  await pair.close();
  for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, hasTouch: width === 390, permissions: ['microphone'] });
    await context.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    const page = await context.newPage();
    currentPage = page;
    await page.goto(`${base}/neo`);
    const form = page.locator('form.neo-composer-input');
    const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
    for (const intent of ['draft', 'send']) {
      await input.fill('Visual preview draft.');
      await form.getByRole('button', { name: 'Start voice input', exact: true }).click();
      await form.getByTestId('voice-recording-draft').getByText('Preview transcript.', { exact: true }).waitFor();
      const initialTimer = await form.getByTestId('voice-timer').innerText();
      await page.waitForFunction(initial => document.querySelector('[data-testid=voice-timer]')?.textContent !== initial, initialTimer);
      await form.getByRole('button', { name: intent === 'draft' ? 'Stop recording and keep the text as a draft' : 'Stop recording and send the message', exact: true }).click();
      const label = form.getByTestId('voice-transcribing');
      await label.waitFor();
      assert.equal(await label.innerText(), 'Transcribing…');
      assert.equal(await form.getByTestId('voice-bars').count(), 0);
      assert.equal(await form.getByTestId('voice-recording-panel').locator('.animate-spin').count(), 0);
      const busy = form.locator('button[aria-busy="true"]');
      assert.equal(await busy.count(), 1);
      assert.equal(await busy.getAttribute('aria-label'), intent === 'draft' ? 'Stop recording and keep the text as a draft' : 'Send message');
      assert.equal(await busy.getByRole('status', { name: 'Loading', exact: true }).count(), 1);
      assert.equal(await page.getByText('Transcribing into your draft…', { exact: true }).count(), 0);
      await page.screenshot({ path: `${run}/evidence/${theme}-${width}-${intent}-transcribing.png` });
      receipts.push({ theme, width, intent, spinnerInActiveButton: true, textWithoutWaveform: true });
      await form.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
      if (intent === 'draft') assert((await input.inputValue()).includes('Preview transcript.'));
    }
    await context.close();
  }
  console.log(`PASS: ${receipts.length} transcription states; active-button spinner and text-only waveform area`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: `${run}/evidence/failure.png` });
    writeFileSync(`${run}/evidence/failure.txt`, await currentPage.locator('body').innerText());
  }
  throw error;
} finally {
  writeFileSync(`${run}/evidence/transcribing.json`, JSON.stringify(receipts, null, 2));
  await browser.close();
}
