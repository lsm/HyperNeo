import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run, asrPort] = process.argv.slice(2);
assert(!['8399', '8499'].includes(port));
const base = `http://127.0.0.1:${port}`;
const rpc = (name, input = {}) => JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { encoding: 'utf8' })).reply;
const configure = mode => assert(rpc('rpc:settings.global.update', { updates: { language: 'en', voice: { enabled: true, mode, model: 'synthetic', endpoint: `http://127.0.0.1:${asrPort}/transcribe`, streamEndpoint: `ws://127.0.0.1:${asrPort}/v1/listen`, streamProtocol: 'deepgram', allowPrivateNetwork: true } } }).success);
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const receipts = [];
let page;
let batchResponses = 0;
try {
  const pairing = await browser.newContext();
  const made = rpc('device.pair.create', { kind: 'human' });
  assert.equal((await pairing.request.post(`${base}/pair`, { headers: { origin: base }, data: { code: made.code, name: 'Synthetic behavior browser' } })).status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  const open = async (theme, width) => {
    const context = await browser.newContext({ storageState, viewport: { width, height: 900 }, hasTouch: width === 390, permissions: ['microphone'] });
    await context.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    page = await context.newPage();
    batchResponses = 0;
    page.on('websocket', socket => {
      const requests = new Set();
      socket.on('framesent', frame => {
        const message = JSON.parse(String(frame.payload));
        if (message.method === 'voice.transcribe') requests.add(message.id);
      });
      socket.on('framereceived', frame => {
        const message = JSON.parse(String(frame.payload));
        if (requests.delete(message.requestId)) batchResponses++;
      });
    });
    await page.goto(`${base}/neo`);
    return context;
  };
  const ordinal = async context => (await (await context.request.get(`http://127.0.0.1:${asrPort}/fixture/status`)).json()).utterances;
  const started = async mode => {
    const form = page.locator('form.neo-composer-input');
    await form.getByRole('button', { name: 'Start voice input', exact: true }).click();
    await form.getByTestId('voice-timer').waitFor();
    if (mode === 'streaming') await form.getByTestId('voice-interim-text').waitFor();
    const initial = await form.getByTestId('voice-timer').innerText();
    await page.waitForFunction(value => document.querySelector('[data-testid=voice-timer]')?.textContent !== value, initial);
    return form;
  };
  const waitForOrdinal = async (context, previous) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await ordinal(context);
      if (current > previous) return current;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('ASR request did not start');
  };
  for (const mode of ['streaming', 'batch']) for (const width of [390, 1280]) for (const intent of ['draft', 'send']) {
    configure(mode);
    const theme = mode === 'streaming' ? 'light' : 'dark';
    const context = await open(theme, width);
    const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
    await input.fill('Original draft.');
    const oldOrdinal = await ordinal(context);
    const previousResponses = batchResponses;
    const form = await started(mode);
    await form.getByRole('button', { name: intent === 'draft' ? 'Stop recording and keep the text as a draft' : 'Stop recording and send the message', exact: true }).click();
    await form.getByTestId('voice-transcribing').waitFor();
    const oldText = `Proof transcript ${await waitForOrdinal(context, oldOrdinal)}.`;
    const cancel = form.getByRole('button', { name: 'Cancel recording', exact: true });
    assert.equal(await cancel.isEnabled(), true);
    await page.screenshot({ path: `${run}/evidence/${mode}-${width}-${intent}-pending.png` });
    await cancel.click();
    await form.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
    assert.equal(await input.inputValue(), 'Original draft.');
    await page.getByTestId('pending-voice-audio-tray').waitFor({ state: 'hidden' });
    await page.screenshot({ path: `${run}/evidence/${mode}-${width}-${intent}-cancelled.png` });
    const priorNew = await ordinal(context);
    await started(mode);
    if (mode === 'batch') {
      const deadline = Date.now() + 5000;
      while (batchResponses === previousResponses && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert(batchResponses > previousResponses, 'cancelled batch response must arrive during the new recording');
      assert.equal(await form.getByTestId('voice-timer').isVisible(), true);
    }
    await form.getByRole('button', { name: 'Stop recording and keep the text as a draft', exact: true }).click();
    await form.getByTestId('voice-transcribing').waitFor();
    const newText = `Proof transcript ${await waitForOrdinal(context, priorNew)}.`;
    assert.notEqual(newText, oldText);
    await form.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
    assert.equal(await input.inputValue(), `Original draft.\n${newText}`);
    assert.equal((await page.locator('article').allTextContents()).join('\n').includes(oldText), false);
    receipts.push({ mode, theme, width, intent, cancelledTextDiscarded: true, nextRecordingPreserved: true });
    console.log(`PASS: cancellation ${mode}/${width}/${intent}`);
    await context.close();
  }
  configure('streaming');
  const context = await open('dark', 390);
  const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
  await input.fill('Capped draft.');
  const form = page.locator('form.neo-composer-input');
  const began = Date.now();
  await form.getByRole('button', { name: 'Start voice input', exact: true }).click();
  const timer = form.getByTestId('voice-timer');
  await timer.waitFor();
  assert.match(await timer.innerText(), /^0:0[0-2]$/);
  await page.screenshot({ path: `${run}/evidence/cap-start.png` });
  for (const minute of [1, 2, 3]) {
    await page.waitForFunction(minute => {
      const text = document.querySelector('[data-testid=voice-timer]')?.textContent;
      if (!text) return true;
      const [m, s] = text.split(':').map(Number);
      return m * 60 + s >= minute * 60;
    }, minute, { timeout: 65000 });
    assert.equal(await timer.isVisible(), true, 'recording must remain active before four minutes');
    console.log(`cap elapsed: ${await timer.innerText()}`);
  }
  await form.getByTestId('voice-transcribing').waitFor({ timeout: 70000 });
  const stoppedAtMs = Date.now() - began;
  assert(stoppedAtMs >= 239000 && stoppedAtMs <= 250000, `cap stopped at ${stoppedAtMs}ms`);
  await page.screenshot({ path: `${run}/evidence/cap-transcribing.png` });
  await form.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
  assert.match(await input.inputValue(), /^Capped draft\.\nProof transcript \d+\.$/);
  await page.getByTestId('pending-voice-audio-tray').waitFor({ state: 'hidden' });
  await page.screenshot({ path: `${run}/evidence/cap-draft.png` });
  receipts.push({ cap: true, stoppedAtMs, finalDraft: await input.inputValue() });
  await context.close();
  console.log('PASS: real four-minute cap returned the transcript to the draft');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: `${run}/evidence/behavior-failure.png` });
    writeFileSync(`${run}/evidence/behavior-failure.txt`, await page.locator('body').innerText());
  }
  throw error;
} finally {
  writeFileSync(`${run}/evidence/behavior.json`, JSON.stringify(receipts, null, 2));
  await browser.close();
}
