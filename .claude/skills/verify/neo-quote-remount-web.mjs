import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const [port, out] = process.argv.slice(2);
assert(!['8399', '8499'].includes(port));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const base = `http://127.0.0.1:${port}`;
const results = [],
  timers = new Set();
mkdirSync(out, { recursive: true });
const isolate = (context) =>
  context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
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
    const context = await browser.newContext({
      storageState,
      hasTouch: touch,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
    await isolate(context);
    const page = await context.newPage();
    let delay = 0;
    await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        if (delay && request.type === 'REQ' && request.data?.name === 'neo.message.send') {
          const timer = setTimeout(() => {
            timers.delete(timer);
            server.send(raw);
          }, delay);
          timers.add(timer);
        } else server.send(raw);
      });
      server.onMessage((raw) => socket.send(raw));
    });
    await page.goto(`${base}/neo`);
    const input = page.locator('textarea').first();
    await input.waitFor();
    assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), touch);
    const send = () =>
      touch
        ? page.getByRole('button', { name: 'Send message', exact: true }).tap()
        : input.press('Enter');
    if (!touch)
      for (let i = 0; i < 7; i++) {
        const count = await page.locator('[data-public-entry].neo-message-user').count();
        await input.fill(`History ${i}\n` + 'Synthetic history line\n'.repeat(8));
        await send();
        await page.waitForFunction(
          (n) => document.querySelectorAll('[data-public-entry].neo-message-user').length > n,
          count
        );
        await page.locator('[data-send-flight]').waitFor({ state: 'detached' });
      }
    const pictures = await page.evaluate(() =>
      [0, 1].map((index) => {
        const canvas = document.createElement('canvas');
        canvas.width = index ? 90 : 120;
        canvas.height = index ? 60 : 80;
        const draw = canvas.getContext('2d');
        draw.fillStyle = index ? '#d4a420' : '#287db6';
        draw.fillRect(0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png').split(',')[1];
      })
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const reply = page
        .locator('[data-public-entry].neo-message-user')
        .first()
        .getByRole('button', { name: 'Reply to your message', exact: true });
      await reply.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      if (touch) await reply.tap();
      else await reply.click();
      await page.locator('form [data-quote-bar] .neo-quote-excerpt').waitFor();
      await page
        .locator('input[type=file]')
        .first()
        .setInputFiles([
          {
            name: 'photo-0.png',
            mimeType: 'image/png',
            buffer: Buffer.from(pictures[0], 'base64'),
          },
          {
            name: 'notes.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('File body\n亮\n```literal```'),
          },
          {
            name: 'photo-1.png',
            mimeType: 'image/png',
            buffer: Buffer.from(pictures[1], 'base64'),
          },
        ]);
      await page.waitForFunction(
        () => document.querySelectorAll('[aria-label="Attachments"] > li').length === 3
      );
      await input.fill('Flying attachments\nWith their quote');
      await page.evaluate(() => {
        window.quoteFrames = [];
        let tracked;
        const start = performance.now();
        const box = (element) => {
          if (!element) return null;
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const frame = () =>
          setTimeout(() => {
            const pending = [...document.querySelectorAll('[data-pending-ask]')].at(-1);
            tracked = pending?.dataset.pendingAsk ?? tracked;
            const row = tracked
              ? document.querySelector(
                  `[data-pending-ask="${CSS.escape(tracked)}"], [data-message-ref="${CSS.escape(tracked)}"]`
                )
              : null;
            window.quoteFrames.push({
              ms: performance.now() - start,
              pending: row?.hasAttribute('data-pending-ask'),
              quote: box(row?.querySelector('[data-quote-bar]')),
              rendered: !!row?.querySelector('[data-quote-bar] .neo-quote-excerpt'),
              photo: box(row?.querySelector('img')),
            });
            if (performance.now() - start < 2200) requestAnimationFrame(frame);
          }, 0);
        requestAnimationFrame(frame);
      });
      delay = 1000;
      await send();
      await page.waitForTimeout(650);
      const label = `${touch ? 'touch' : 'fine'}-${width}`;
      await page.screenshot({ path: join(out, `pending-${label}.png`) });
      await page.waitForTimeout(1700);
      delay = 0;
      const frames = await page.evaluate(() => window.quoteFrames);
      results.push({ touch, width, frames });
      writeFileSync(join(out, 'evidence.json'), JSON.stringify(results, null, 2));
      await page.screenshot({ path: join(out, `durable-${label}.png`) });
      const settled = frames.filter((frame) => frame.ms > 650 && frame.quote);
      assert(
        settled.length > 20 &&
          settled.some((f) => f.pending) &&
          settled.some((f) => f.pending === false),
        'Missing pending/durable frames'
      );
      assert(
        settled.every((f) => f.rendered),
        'A ready quote returned to its loading fallback'
      );
      assert(
        settled.every((f) => Math.abs(f.quote.height - settled[0].quote.height) < 1),
        'Quote height changed after landing'
      );
    }
    await context.close();
  }
  console.log(
    'PASS: delayed pending/durable replacement preserves ready quote rendering and height in every frame at 1280/390px with fine/coarse pointers'
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  await browser.close();
}
