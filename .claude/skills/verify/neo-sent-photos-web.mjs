import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const [port, out] = process.argv.slice(2);
assert(!['8399', '8499'].includes(port));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`;
const observations = [];
mkdirSync(out, { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(`${base}/pair#${process.env.PAIR_CODE}`);
    await page.getByRole('button', { name: 'Pair this browser' }).click();
    await page.getByText('This browser is paired.').waitFor();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/neo`);
    const input = page.locator('textarea').first();
    await input.waitFor();
    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 360; canvas.height = 240;
      const draw = canvas.getContext('2d');
      draw.fillStyle = '#2563eb'; draw.fillRect(0, 0, 360, 240);
      draw.fillStyle = '#fbbf24'; draw.fillRect(80, 40, 200, 160);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    for (const words of ['The lamp flickers', '']) {
      const before = await page.locator('[data-public-entry].neo-message-user').count();
      await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
      await page.locator('[aria-label="Attachments"]').waitFor();
      await input.fill(words);
      await input.press('Enter');
      await page.waitForFunction(n => document.querySelectorAll('[data-public-entry].neo-message-user').length > n, before);
      const row = page.locator('[data-public-entry].neo-message-user').last();
      await row.scrollIntoViewIfNeeded();
      const photo = row.getByRole('img', { name: 'Attached photo 1' });
      await photo.waitFor();
      const layout = await row.evaluate(row => {
        const photo = row.querySelector('img');
        const bubble = row.querySelector('.neo-message-bubble');
        const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, height: r.height }; };
        return { photo: box(photo), row: box(row), bubble: bubble ? box(bubble) : null, inside: !!bubble?.contains(photo), text: bubble?.textContent, rightAligned: !!photo.closest('.justify-end') };
      });
      const name = words ? 'photo-words' : 'photo-only';
      await page.screenshot({ path: join(out, `${name}-${width}.png`) });
      observations.push({ width, name, ...layout });
      writeFileSync(join(out, 'evidence.json'), JSON.stringify(observations, null, 2));
      assert.equal(layout.inside, false);
      assert.equal(layout.rightAligned, true);
      assert(layout.photo.height <= 256 && layout.photo.right <= width);
      if (words) {
        assert(layout.photo.bottom <= layout.bubble.y);
        assert.equal(layout.text, words);
      } else {
        assert.equal(layout.bubble, null);
        assert.equal(await row.getByText('Attached files', { exact: true }).count(), 0);
        assert.equal(await row.getByRole('button', { name: /Reply/ }).count(), 0);
        assert.equal(await row.getByTitle('Copy your message', { exact: true }).isDisabled(), true);
      }
      const trigger = row.getByRole('button', { name: 'Open attached photo 1', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Attached photo 1' });
      await dialog.waitFor();
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(node => node === document.activeElement), true);
      await page.screenshot({ path: join(out, `${name}-open-${width}.png`) });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Enter');
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    }
  }
  await context.close();
  console.log('PASS: sent photos above words, photo-only without bubble, enlargement and keyboard focus at 1280/390px');
} finally {
  await browser.close();
}
