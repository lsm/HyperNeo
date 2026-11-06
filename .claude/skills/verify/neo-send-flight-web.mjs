import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const [port, out] = process.argv.slice(2);
assert(!['8399', '8499'].includes(port));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`;
const evidence = [];
mkdirSync(out, { recursive: true });
const timers = new Set();
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
  const context = await browser.newContext({ storageState, hasTouch: touch, viewport: { width: 1280, height: 900 }, locale: 'en-US', reducedMotion: 'no-preference' });
  await isolate(context);
  const page = await context.newPage();
  let delay = 0;
  await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`, socket => {
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (delay && request.type === 'REQ' && request.data?.name === 'neo.message.send') {
        const timer = setTimeout(() => { timers.delete(timer); server.send(raw); }, delay);
        timers.add(timer);
      } else server.send(raw);
    });
    server.onMessage(raw => socket.send(raw));
  });
  await page.goto(`${base}/neo`);
  const input = page.locator('textarea').first();
  await input.waitFor();
  const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  assert.equal(coarse, touch, 'Pointer mode does not match the scenario');
  const send = () => touch ? page.getByRole('button', { name: 'Send message', exact: true }).tap() : input.press('Enter');
  if (!touch) for (let i = 0; i < 7; i++) {
    const count = await page.locator('[data-public-entry].neo-message-user').count();
    await input.fill(`History ${i}\n` + 'Synthetic history line\n'.repeat(15));
    await send();
    await page.waitForFunction(n => document.querySelectorAll('[data-public-entry].neo-message-user').length > n, count);
    await page.locator('[data-send-flight]').waitFor({ state: 'detached' });
  }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const acceptDelay of [250, 1000]) {
      const reply = page.locator('[data-public-entry].neo-message-user').first().getByRole('button', { name: 'Reply to your message', exact: true });
      if (touch) await reply.tap();
      else await reply.click();
      await page.locator('form [data-quote-bar]').waitFor();
      const words = `Flying words at ${width}, delay ${acceptDelay}` + (acceptDelay === 1000 ? "\nSecond line\nThird line\nFourth line" : "");
      await input.fill(words);
      await page.evaluate(() => {
        const rail = document.querySelector('.neo-chat-rail');
        const main = document.querySelector('main.neo-scroll');
        const scroll = rail.scrollHeight > rail.clientHeight + 100 ? rail : main;
        scroll.scrollTop = 0;
        scroll.dispatchEvent(new Event('scroll'));
      });
      delay = acceptDelay;
      await page.evaluate(() => {
        window.flightFrames = [];
        const start = performance.now();
        let tracked;
        const frame = () => setTimeout(() => {
          const ghost = document.querySelector('[data-send-flight]');
          if (ghost) tracked = ghost.dataset.sendFlight;
          const row = tracked ? document.querySelector(`[data-pending-ask="${CSS.escape(tracked)}"], [data-message-ref="${CSS.escape(tracked)}"]`) : null;
          const box = element => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          const rail = document.querySelector('.neo-chat-rail');
          const main = document.querySelector('main.neo-scroll');
          const scroll = rail.scrollHeight > rail.clientHeight + 100 ? rail : main;
          window.flightFrames.push({ ms: performance.now() - start, ghost: box(ghost), ghostWords: box(ghost?.lastElementChild), targetWords: box(row?.querySelector('.neo-clamped-text p')), ghostVisible: ghost ? getComputedStyle(ghost).visibility : null, ghostText: ghost?.textContent, bubble: box(row?.querySelector('.neo-message-bubble')), row: row ? { pending: row.hasAttribute('data-pending-ask'), visibility: getComputedStyle(row).visibility, height: row.getBoundingClientRect().height, arrive: row.classList.contains('neo-arrive') } : null, composerQuote: !!document.querySelector('form [data-quote-bar]'), ghostQuote: !!ghost?.querySelector('[data-quote-bar]'), distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight, chrome: ghost ? Number(ghost.style.getPropertyValue('--neo-flight-chrome')) : null });
          if (performance.now() - start < 1800) requestAnimationFrame(frame);
        }, 0);
        requestAnimationFrame(frame);
      });
      await send();
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(out, `flight-mid-${touch ? 'touch' : 'fine'}-${acceptDelay}-${width}.png`) });
      await page.waitForTimeout(1750);
      delay = 0;
      const frames = await page.evaluate(() => window.flightFrames);
      evidence.push({ width, touch, coarse, acceptDelay, frames });
      writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
      await page.screenshot({ path: join(out, `flight-landed-${touch ? 'touch' : 'fine'}-${acceptDelay}-${width}.png`) });
      const moving = frames.filter(f => f.ghost && f.ghost.width > 0 && f.ghostVisible === 'visible');
      assert(moving.length >= 10, 'No visible flight across enough browser frames');
      assert(moving.every(f => f.ghostText.includes(words)), 'Words did not travel in the ghost');
      assert(moving.some(f => f.ghostQuote), 'Quote did not travel with words');
      assert(moving.every(f => !f.composerQuote), 'Quote remained in the composer during flight');
      assert(moving.every(f => f.row?.visibility === 'hidden'), 'Destination row was visible during flight');
      assert(moving.at(-1).ms - moving[0].ms >= 450, 'Flight ended too early');
      if (acceptDelay === 250) {
        assert(moving.some(f => f.row?.pending) && moving.some(f => f.row && !f.row.pending), 'No pending-to-durable replacement during flight');
      } else {
        assert(frames.find(f => f.row && !f.row.pending).ms > moving.at(-1).ms, 'Acceptance was not delayed past landing');
      }
      const last = moving.at(-1);
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(last.ghost[key] - last.bubble[key]) < 5, `Ghost missed the landing ${key}`);
      assert(Math.abs(last.ghostWords.height - last.targetWords.height) < 2, 'Words changed line height at landing');
      const settled = frames.filter(f => f.ms > 650 && f.bubble);
      assert(settled.every(f => f.distance < 3), 'Send did not stay at the bottom');
      const first = settled[0].bubble, final = settled.at(-1).bubble;
      assert(Math.abs(first.y - final.y) < 3, 'Bubble jumped when acceptance replaced the landed pending row');
      assert(settled.filter(f => f.row && !f.row.pending).every(f => !f.row.arrive), 'Durable row faded in again');
    }
  }
  await context.close();
  }
  console.log('PASS: 550ms quoted send, bottom pin, pending replacement and delayed acceptance with fine/coarse pointers at 1280/390px');
} finally {
  for (const timer of timers) clearTimeout(timer);
  await browser.close();
}
