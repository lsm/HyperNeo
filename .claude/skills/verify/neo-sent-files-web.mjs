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
const file = { name: 'notes_[v1].txt', text: '<b>Plain text, not HTML</b>\n```js\nconst lamp = "亮";\n```' };
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
    for (const words of ['Please read this', '']) {
      const before = await page.locator('[data-public-entry].neo-message-user').count();
      await page.locator('input[type=file]').first().setInputFiles({ name: file.name, mimeType: 'text/plain', buffer: Buffer.from(file.text) });
      await page.locator('[aria-label="Attachments"]').waitFor();
      await input.fill(words);
      await input.press('Enter');
      await page.waitForFunction(n => document.querySelectorAll('[data-public-entry].neo-message-user').length > n, before);
      const row = page.locator('[data-public-entry].neo-message-user').last();
      await row.scrollIntoViewIfNeeded();
      const card = row.getByRole('button', { name: `Open file: ${file.name}`, exact: true });
      await card.waitFor();
      const name = words ? 'file-words' : 'file-only';
      const layout = await card.evaluate(card => {
        const row = card.closest('article');
        const bubble = row.querySelector('.neo-message-bubble');
        const r = card.getBoundingClientRect();
        return { x: r.x, right: r.right, bottom: r.bottom, height: r.height, insideBubble: !!bubble?.contains(card), bubbleY: bubble?.getBoundingClientRect().y, words: bubble?.textContent ?? null, hasFileBody: !!row.querySelector('pre'), rightAligned: !!card.closest('.justify-end') };
      });
      observations.push({ width, name, ...layout });
      writeFileSync(join(out, 'evidence.json'), JSON.stringify(observations, null, 2));
      await page.screenshot({ path: join(out, `${name}-${width}.png`) });
      assert.equal(layout.insideBubble, false);
      assert.equal(layout.rightAligned, true);
      assert.equal(layout.hasFileBody, false);
      assert.equal(layout.words, words || null);
      assert(layout.height < 100 && layout.x >= 0 && layout.right <= width);
      if (words) assert(layout.bottom <= layout.bubbleY);
      assert.equal(await row.getByTitle('Copy your message', { exact: true }).isEnabled(), true);
      assert.equal(await row.getByRole('button', { name: 'Reply to your message', exact: true }).count(), 1);
      await card.click();
      const dialog = page.getByRole('dialog', { name: file.name, exact: true });
      await dialog.waitFor();
      await dialog.evaluate(node => Promise.all([
        ...node.getAnimations(), ...node.parentElement.getAnimations(),
      ].map(animation => animation.finished)));
      assert.equal(await dialog.locator('pre').textContent(), file.text);
      assert.equal(await dialog.locator('b, code').count(), 0);
      assert.equal(await dialog.locator('pre').evaluate(node => getComputedStyle(node).userSelect), 'text');
      await page.screenshot({ path: join(out, `${name}-open-${width}.png`) });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      await row.getByRole('button', { name: 'Reply to your message', exact: true }).click();
      const quote = page.locator('form.neo-composer-input [data-quote-bar]');
      await quote.waitFor();
      assert((await quote.textContent()).includes(words || 'Attached files'));
      await page.keyboard.press('Escape');
      await quote.waitFor({ state: 'detached' });
    }
  }
  await context.close();
  console.log('PASS: file cards above words, file-only without a bubble, literal selectable text reader and reply at 1280/390px');
} finally {
  await browser.close();
}
