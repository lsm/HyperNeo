import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const run = realpathSync(process.argv[2]);
const port = process.argv[3] ?? '9491';
assert.notEqual(port, '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const plainHttp = process.env.VERIFY_PLAIN_HTTP === '1';
const evidence = join(run, 'evidence', plainHttp ? 'plain-http' : 'localhost');
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, args: plainHttp ? ['--host-resolver-rules=MAP preview.invalid 127.0.0.1', '--no-proxy-server'] : [], ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://${plainHttp ? 'preview.invalid' : 'localhost'}:${port}`;
const observed = {};
try {
  for (const width of [1440, 1120, 768, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 1120, locale: 'en-US' });
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const page = await context.newPage();
    try {
      await page.goto(`${base}/neo`);
      assert.equal(await page.evaluate(() => window.isSecureContext), !plainHttp);
      if (plainHttp) assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
      const narrow = width < 1120;
      await page.getByRole('heading', { name: 'A little less on your mind.' }).waitFor();
      if (narrow) await page.getByRole('button', { name: /your work/i }).click();
      const first = page.getByRole('button', { name: 'Open preview: Launch plan (Markdown)' });
      const second = page.getByRole('button', { name: 'Open preview: proposal.md' });
      const panel = page.getByRole('dialog');
      await first.click();
      await panel.getByRole('heading', { name: 'Launch plan', exact: true }).waitFor();
      if (!narrow) await page.waitForFunction(() => {
        const chat = document.querySelector('.neo-chat-rail').getBoundingClientRect();
        const input = document.querySelector('textarea').getBoundingClientRect();
        return input.right <= chat.right + 1;
      });
      if (narrow) {
        await page.screenshot({ path: join(evidence, `layout-opening-${width}.png`) });
        await page.waitForFunction(() => Math.abs(document.querySelector('.artifact-preview-panel').getBoundingClientRect().bottom - innerHeight) < 1);
      }
      const bounds = await panel.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 901);
      await page.screenshot({ path: join(evidence, `layout-markdown-${width}.png`) });
      if (!narrow) {
        const chat = await page.locator('.neo-chat-rail').boundingBox();
        const input = page.locator('textarea').first();
        const composer = await input.boundingBox();
        assert(chat && chat.x + chat.width <= bounds.x + 1);
        assert(composer && composer.x + composer.width <= chat.x + chat.width + 1);
        await input.fill('A draft while reading the preview');
        assert.equal(await input.inputValue(), 'A draft while reading the preview');
        await input.fill('');
        await second.click();
        await panel.getByRole('heading', { name: 'PR layout proposal' }).waitFor();
        assert.equal(await panel.count(), 1);
        assert(await panel.getByText(/commit aaaaaaa/).count());
        await page.screenshot({ path: join(evidence, `layout-git-${width}.png`) });
        await page.getByRole('button', { name: 'Model and thinking', exact: true }).click();
        await page.locator('#neo-preferences').waitFor();
        await input.focus();
        await page.keyboard.press('Escape');
        await page.locator('#neo-preferences').waitFor({ state: 'detached' });
        assert.equal(await panel.count(), 1);
        await page.getByRole('button', { name: 'Reply in chat', exact: true }).click();
        const quote = page.getByRole('region', { name: /^Replying to/ });
        await quote.waitFor();
        await input.focus();
        await page.keyboard.press('Escape');
        await quote.waitFor({ state: 'detached' });
        assert.equal(await panel.count(), 1);
        await page.keyboard.press('Escape');
      } else {
        await page.getByRole('button', { name: 'Dismiss preview' }).click({ position: { x: 20, y: 20 } });
      }
      await panel.waitFor({ state: 'detached' });
      await first.click();
      await panel.getByRole('heading', { name: 'Launch plan', exact: true }).waitFor();
      await page.goBack();
      await panel.waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).pathname, '/neo');
      await second.click();
      await panel.getByRole('heading', { name: 'PR layout proposal' }).waitFor();
      if (narrow) await page.waitForFunction(() => Math.abs(document.querySelector('.artifact-preview-panel').getBoundingClientRect().bottom - innerHeight) < 1);
      await page.screenshot({ path: join(evidence, `layout-git-final-${width}.png`) });
      if (narrow) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: width / 2, y: 105 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: width / 2, y: 230 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await panel.waitFor({ state: 'detached' });
        await first.click();
        await panel.getByRole('heading', { name: 'Launch plan', exact: true }).waitFor();
      }
      await page.getByRole('button', { name: 'Close preview' }).click();
      await panel.waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).pathname, '/neo');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      observed[width] = { bounds, browserBackStaysOnNeo: true, close: true, ...(narrow ? { stripDismiss: true, swipeDown: true } : { chatEditable: true, replacesContent: true, escapeFromChat: true, quoteEscapePreservesPreview: true, preferencesEscapePreservesPreview: true }) };
    } catch (error) {
      await page.screenshot({ path: join(evidence, `layout-failure-${width}.png`) });
      throw error;
    } finally { await context.close(); }
  }
  writeFileSync(join(evidence, 'layout.json'), JSON.stringify({ verified: true, plainHttp, observed }, null, 2));
  console.log(JSON.stringify(observed));
} finally { await browser.close(); }
