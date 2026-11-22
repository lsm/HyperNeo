import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [port, code, sessionId, mode, png, run] = process.argv.slice(2);
const origin = `http://127.0.0.1:${port}`;
const flash = mode === 'flash-web';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ executablePath: process.env.VERIFY_BROWSER, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 770 } });
  page.on('pageerror', (error) => console.error(error.message));
  const response = await page.request.post(`${origin}/pair`, {
    headers: { origin }, data: { code, name: 'Synthetic DeepSeek browser' },
  });
  assert.equal(response.status(), 200);
  await page.goto(`${origin}/session/${sessionId}`);
  const composer = page.locator('.chat-footer');
  const input = composer.getByRole('textbox');
  const picker = composer.getByRole('button', { name: 'Choose model and thinking' });
  const options = composer.getByTitle('More options');
  await input.waitFor();
  await options.click();
  const attach = composer.getByRole('button', { name: 'Attach image' });
  await attach.waitFor();
  assert.equal(await attach.isEnabled(), flash);
  assert.equal(await composer.getByText(/accepts text only/).isVisible(), !flash);
  await page.screenshot({
    path: join(run, 'evidence', `${mode}-attachment.png`),
    clip: { x: 280, y: 550, width: 840, height: 220 },
    animations: 'disabled',
  });
  if (flash) {
    const chooser = page.waitForEvent('filechooser');
    await attach.click();
    await (await chooser).setFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const remove = composer.getByRole('button', { name: 'Remove attachment' });
    await remove.waitFor();
    await remove.click();
  } else {
    await options.click();
  }

  for (const eventType of ['drop', 'paste']) {
    await input.evaluate((element, { eventType, png }) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), (byte) => byte.charCodeAt(0))], 'pixel.png', { type: 'image/png' }));
      element.dispatchEvent(eventType === 'paste'
        ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
        : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }, { eventType, png });
    const remove = composer.getByRole('button', { name: 'Remove attachment' });
    if (flash) {
      await remove.waitFor();
      if (eventType === 'drop') await remove.click();
    } else {
      assert.equal(await remove.count(), 0);
    }
  }

  await input.fill(flash ? 'Verify model and images' : 'Synthetic DeepSeek prompt');
  await input.press('Enter');
  await page.getByText(flash ? /"model":"deepseek-v4-flash"/ : 'Synthetic DeepSeek reply').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('button[aria-label="Choose model and thinking"]')?.disabled);
  assert.equal(await picker.isDisabled(), true);
  await page.screenshot({ path: join(run, 'evidence', `${mode}-reply.png`), animations: 'disabled' });
  console.log(JSON.stringify({ mode, attach: flash, paste: flash, drop: flash, modelLocked: true, replies: 1 }));
} finally {
  await browser.close();
}
