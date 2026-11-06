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
const evidence = [];
const manual = [];
const timers = new Set();
const isolate = (context) =>
  context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
mkdirSync(out, { recursive: true });
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
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      reducedMotion: 'reduce',
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
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    assert.equal(coarse, touch, 'Pointer mode does not match the scenario');
    const send = () =>
      touch
        ? page.getByRole('button', { name: 'Send message', exact: true }).tap()
        : input.press('Enter');
    if (!touch)
      for (let i = 0; i < 7; i++) {
        const count = await page.locator('[data-public-entry].neo-message-user').count();
        await input.fill(`History ${i}\n` + 'Synthetic history line\n'.repeat(15));
        await send();
        await page.waitForFunction(
          (n) => document.querySelectorAll('[data-public-entry].neo-message-user').length > n,
          count
        );
      }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const acceptDelay of [250, 1000]) {
        const reply = page
          .locator('[data-public-entry].neo-message-user')
          .first()
          .getByRole('button', { name: 'Reply to your message', exact: true });
        if (touch) await reply.tap();
        else await reply.click();
        await page.locator('form [data-quote-bar]').waitFor();
        const words = `Multiline reply at ${width}, delay ${acceptDelay}\nSecond line\nThird line\nFourth line`;
        await input.fill(words);
        await page.evaluate(() => {
          const rail = document.querySelector('.neo-chat-rail');
          const main = document.querySelector('main.neo-scroll');
          const scroll = rail.scrollHeight > rail.clientHeight + 100 ? rail : main;
          scroll.scrollTop = scroll.scrollHeight;
          scroll.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(100);
        delay = acceptDelay;
        await page.evaluate(() => {
          window.pinFrames = [];
          const start = performance.now();
          let tracked;
          const frame = () =>
            setTimeout(() => {
              const pending = [...document.querySelectorAll('[data-pending-ask]')].at(-1);
              if (pending) tracked = pending.dataset.pendingAsk;
              const row = tracked
                ? document.querySelector(
                    `[data-pending-ask="${CSS.escape(tracked)}"], [data-message-ref="${CSS.escape(tracked)}"]`
                  )
                : null;
              const bubble = row?.querySelector('.neo-message-bubble')?.getBoundingClientRect();
              const rail = document.querySelector('.neo-chat-rail');
              const main = document.querySelector('main.neo-scroll');
              const scroll = rail.scrollHeight > rail.clientHeight + 100 ? rail : main;
              window.pinFrames.push({
                ms: performance.now() - start,
                pending: !!row?.hasAttribute('data-pending-ask'),
                rowHeight: row?.getBoundingClientRect().height,
                bubble: bubble
                  ? { x: bubble.x, y: bubble.y, width: bubble.width, height: bubble.height }
                  : null,
                distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
              });
              if (performance.now() - start < 1800) requestAnimationFrame(frame);
            }, 0);
          requestAnimationFrame(frame);
        });
        await send();
        await page.waitForTimeout(650);
        const label = `${touch ? 'touch' : 'fine'}-${width}-${acceptDelay}`;
        await page.screenshot({ path: join(out, `pending-${label}.png`) });
        await page.waitForTimeout(1250);
        delay = 0;
        const frames = await page.evaluate(() => window.pinFrames);
        evidence.push({ width, touch, coarse, acceptDelay, frames });
        writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
        await page.screenshot({ path: join(out, `durable-${label}.png`) });
        assert(
          frames.some((f) => f.pending),
          'No actual pending send was measured'
        );
        assert(
          frames.some((f) => f.bubble && !f.pending),
          'No actual durable replacement was measured'
        );
        assert(
          frames.filter((f) => f.ms > 650 && f.bubble).every((f) => f.distance < 3),
          'Delayed multiline send lost the bottom pin'
        );
      }
    }
    await page.mouse.move(195, 350);
    await page.mouse.wheel(0, -650);
    await page.waitForTimeout(250);
    const anchor = await page.evaluate(() => {
      const rail = document.querySelector('.neo-chat-rail');
      const main = document.querySelector('main.neo-scroll');
      const scroll = rail.scrollHeight > rail.clientHeight + 100 ? rail : main;
      const entry = [...document.querySelectorAll('[data-public-entry]')].find(
        (element) =>
          element.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top + 30
      );
      return { key: entry.dataset.publicEntry, y: entry.getBoundingClientRect().y };
    });
    await page.waitForTimeout(100);
    const other = await context.newPage();
    await other.goto(`${base}/neo`);
    const otherInput = other.locator('textarea').first();
    await otherInput.waitFor();
    const count = await page.locator('[data-public-entry].neo-message-user').count();
    await otherInput.fill(
      'A new message while another window reads history\n' + 'Synthetic line\n'.repeat(8)
    );
    if (touch) await other.getByRole('button', { name: 'Send message', exact: true }).tap();
    else await otherInput.press('Enter');
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-public-entry].neo-message-user').length > n,
      count
    );
    await page.waitForTimeout(300);
    const after = await page.evaluate((key) => {
      const entry = [...document.querySelectorAll('[data-public-entry]')].find(
        (element) => element.dataset.publicEntry === key
      );
      const rail = document.querySelector('.neo-chat-rail');
      const main = document.querySelector('main.neo-scroll');
      const scroll = rail.scrollHeight > rail.clientHeight + 100 ? rail : main;
      return {
        y: entry.getBoundingClientRect().y,
        distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      };
    }, anchor.key);
    manual.push({ touch, anchor, after });
    writeFileSync(join(out, 'manual-reading.json'), JSON.stringify(manual, null, 2));
    await page.screenshot({ path: join(out, `manual-reading-${touch ? 'touch' : 'fine'}.png`) });
    assert(Math.abs(after.y - anchor.y) < 2, 'New content displaced a manual reader');
    assert(after.distance > 160, 'Manual reading was forced to the bottom');
    await other.close();
    await context.close();
  }
  console.log(
    'PASS: delayed multiline replies keep the bottom pin with fine/coarse pointers at 1280/390px'
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  await browser.close();
}
