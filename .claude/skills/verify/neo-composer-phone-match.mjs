import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run, label = 'web'] = process.argv.slice(2);
assert(port && run && !['8399', '8499'].includes(port));
const base = `http://127.0.0.1:${port}`;
const out = `${run}/evidence/${label}`;
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const typed = 'Can you check the build status and merge it if the review bot approved?';
const receipts = [];
try {
  const made = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', '{"kind":"human"}'], { encoding: 'utf8' })).reply;
  const pairing = await browser.newContext();
  assert.equal((await pairing.request.post(`${base}/pair`, { headers: { origin: base }, data: { code: made.code, name: 'Synthetic phone-match browser' } })).status(), 200);
  const storageState = await pairing.storageState();
  await pairing.close();
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ storageState, viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, permissions: ['microphone'], colorScheme: theme });
    await context.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    await context.addInitScript(() => {
      delete window.AudioEncoder;
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext();
        const tone = audio.createOscillator();
        const sink = audio.createMediaStreamDestination();
        tone.connect(sink);
        tone.start();
        return sink.stream;
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => console.error(String(error)));
    await page.goto(`${base}/neo`);
    const input = page.getByRole('textbox', { name: 'Message Neo', exact: true });
    await input.waitFor();
    const form = page.locator('form.neo-composer-input');
    const shot = async state => {
      await page.waitForTimeout(400);
      const box = await form.boundingBox();
      const top = Math.max(0, box.y - 28);
      const clip = { x: 0, y: top, width: 402, height: Math.min(874, box.y + box.height + 20) - top };
      await page.screenshot({ path: `${out}/${state}-${theme}.png`, clip });
      receipts.push({ theme, state, ...(await form.evaluate(el => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height, radius: style.borderTopLeftRadius, shadow: style.boxShadow, background: style.backgroundColor, border: style.borderTopColor };
      })) });
    };
    await page.mouse.click(5, 5);
    await shot('idle');
    await input.click();
    await input.fill(typed);
    await shot('typing');
    await input.fill('');
    await input.focus();
    await form.getByRole('button', { name: 'Start voice input', exact: true }).click();
    await form.getByRole('button', { name: 'Cancel recording', exact: true }).focus();
    await form.getByTestId('voice-interim-text').waitFor();
    await page.waitForTimeout(2500);
    await shot('recording');
    await form.getByRole('button', { name: 'Cancel recording', exact: true }).click();
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${out}/receipts.json`, JSON.stringify(receipts, null, 2));
console.log(JSON.stringify({ out, shots: receipts.length }));
