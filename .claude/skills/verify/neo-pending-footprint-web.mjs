import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const [port, out] = process.argv.slice(2);
assert(!['8399', '8499'].includes(port));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`;
const results = [];
mkdirSync(out, { recursive: true });
const isolate = context => context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
try {
  const pairing = await browser.newContext();
  await isolate(pairing);
  const pairPage = await pairing.newPage();
  await pairPage.goto(`${base}/pair#${process.env.PAIR_CODE}`);
  await pairPage.getByRole('button', { name: 'Pair this browser' }).click();
  await pairPage.getByText('This browser is paired.').waitFor();
  const storageState = await pairing.storageState();
  await pairing.close();

  for (const touch of [false, true]) {
    const context = await browser.newContext({ storageState, hasTouch: touch, viewport: { width: 1280, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' });
    await isolate(context);
    const page = await context.newPage();
    let delay = 0;
    await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`, socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const request = JSON.parse(String(raw));
        if (delay && request.type === 'REQ' && request.data?.name === 'neo.message.send') setTimeout(() => server.send(raw), delay);
        else server.send(raw);
      });
      server.onMessage(raw => socket.send(raw));
    });
    await page.goto(`${base}/neo`);
    const input = page.locator('textarea').first();
    await input.waitFor();
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    assert.equal(coarse, touch, 'The browser pointer mode does not match the scenario');
    const send = () => touch ? page.getByRole('button', { name: 'Send message', exact: true }).tap() : input.press('Enter');
    if (!touch) {
      for (let i = 0; i < 7; i++) {
        const count = await page.locator('[data-public-entry].neo-message-user').count();
        await input.fill(`History ${i}\n` + 'Synthetic history line\n'.repeat(15));
        await send();
        await page.waitForFunction(n => document.querySelectorAll('[data-public-entry].neo-message-user').length > n, count);
      }
    }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [kind, words] of [
        ['plain', `Flying words at ${width}, delay 1000`],
        ['multiline', `Multiline reply at ${width}\nSecond line\nThird line\nFourth line`],
      ]) {
        const reply = page.locator('[data-public-entry].neo-message-user').first().getByRole('button', { name: 'Reply to your message', exact: true });
        if (touch) await reply.tap();
        else await reply.click();
        await page.locator('form [data-quote-bar]').waitFor();
        await input.fill(words);
        await page.evaluate(() => {
          const rail = document.querySelector('.neo-chat-rail');
          const main = document.querySelector('main.neo-scroll');
          const scroll = rail.scrollHeight > rail.clientHeight + 100 ? rail : main;
          scroll.scrollTop = scroll.scrollHeight;
          scroll.dispatchEvent(new Event('scroll'));
        });
        delay = 1100;
        const composerQuote = await page.locator('form [data-quote-bar]').textContent();
        await send();
        const pending = page.locator('[data-pending-ask]').last();
        await pending.waitFor();
        const id = await pending.getAttribute('data-pending-ask');
        await page.waitForTimeout(650);
        const measure = row => {
          const bubble = row.querySelector('.neo-message-bubble');
          const r = row.getBoundingClientRect(), b = bubble.getBoundingClientRect();
          const words = bubble.querySelector('.neo-clamped-text p');
          const style = words ? getComputedStyle(words) : null;
          return { width: r.width, height: r.height, bubbleWidth: b.width, bubbleHeight: b.height, bottom: b.y - r.bottom, quote: bubble.querySelector('[data-quote-bar]')?.textContent, wordsStyle: style ? { font: style.font, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing } : null };
        };
        const before = await pending.evaluate(measure);
        const label = `${touch ? 'touch' : 'fine'}-${kind}-${width}`;
        await page.screenshot({ path: join(out, `pending-${label}.png`) });
        const durable = page.locator(`[data-public-entry][data-message-ref="${id}"]`);
        await durable.waitFor();
        await page.waitForTimeout(250);
        const after = await durable.evaluate(measure);
        await page.screenshot({ path: join(out, `durable-${label}.png`) });
        results.push({ width, touch, coarse, kind, composerQuote, before, after, normalizedJump: after.bottom - before.bottom });
        writeFileSync(join(out, 'evidence.json'), JSON.stringify(results, null, 2));
        assert.equal(before.quote, after.quote, 'Pending and durable quotes display different excerpts');
        assert.equal(composerQuote, after.quote, 'Composer and durable quotes display different excerpts');
        assert(Math.abs(after.bottom - before.bottom) < 2, 'Pending-to-durable bubble footprint changes after acceptance');
        assert(Math.abs(after.height - before.height) < 2, 'Pending and durable rows reserve different heights');
        delay = 0;
      }
    }
    await context.close();
  }
  console.log('PASS: pending/durable quote and row footprints match with fine/coarse pointers at 1280/390px; viewport flight is verified separately');
} finally {
  await browser.close();
}
