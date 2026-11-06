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
      reducedMotion: 'no-preference',
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
    const photo = (index) => ({
      name: `photo-${index}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(pictures[index], 'base64'),
    });
    const file = {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('File body\n亮\n```literal```'),
    };
    if (!touch)
      for (let i = 0; i < 7; i++) {
        const n = await page.locator('[data-public-entry].neo-message-user').count();
        await input.fill(`History ${i}\n` + 'Synthetic history line\n'.repeat(8));
        await send();
        await page.waitForFunction(
          (n) => document.querySelectorAll('[data-public-entry].neo-message-user').length > n,
          n
        );
        await page.locator('[data-send-flight]').waitFor({ state: 'detached' });
      }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const mode of ['photo-only', 'file-only', 'mixed'])
        for (const acceptDelay of [250, 1000]) {
          const files =
            mode === 'photo-only'
              ? [photo(0)]
              : mode === 'file-only'
                ? [file]
                : [photo(0), file, photo(1)];
          const keys =
            mode === 'photo-only'
              ? ['photo-0']
              : mode === 'file-only'
                ? ['file-0']
                : ['photo-0', 'file-0', 'photo-1'];
          if (mode === 'mixed') {
            const reply = page
              .locator('[data-public-entry].neo-message-user')
              .first()
              .getByRole('button', { name: 'Reply to your message', exact: true });
            if (touch) await reply.tap();
            else await reply.click();
          }
          await page.locator('input[type=file]').first().setInputFiles(files);
          await page.waitForFunction(
            (n) => document.querySelectorAll('[aria-label="Attachments"] > li').length === n,
            files.length
          );
          await input.fill(mode === 'mixed' ? 'Flying attachments\nWith their quote' : '');
          const sources = await page
            .locator('[aria-label="Attachments"] > li')
            .evaluateAll((chips) =>
              chips.map((chip) => {
                const source = chip.querySelector('img') ?? chip;
                const r = source.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              })
            );
          await page.evaluate((keys) => {
            window.mediaFrames = [];
            const start = performance.now();
            let tracked;
            const box = (element) => {
              if (!element) return null;
              const r = element.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            };
            const frame = () =>
              setTimeout(() => {
                const overlay = document.querySelector('[data-send-flight]');
                const pending = [...document.querySelectorAll('[data-pending-ask]')].at(-1);
                tracked = overlay?.dataset.sendFlight ?? pending?.dataset.pendingAsk ?? tracked;
                const row = tracked
                  ? document.querySelector(
                      `[data-pending-ask="${CSS.escape(tracked)}"], [data-message-ref="${CSS.escape(tracked)}"]`
                    )
                  : null;
                const rail = document.querySelector('.neo-chat-rail'),
                  main = document.querySelector('main.neo-scroll');
                const scroll = rail.scrollHeight > rail.clientHeight + 100 ? rail : main;
                const ghosts = [...document.querySelectorAll('[data-flight-ghost]')].map(
                  (node) => ({
                    key: node.dataset.flightGhost,
                    box: box(node),
                    radius: parseFloat(getComputedStyle(node).borderRadius),
                    visibility: getComputedStyle(node).visibility,
                    target: box(row?.querySelector(`[data-flight="${node.dataset.flightGhost}"]`)),
                  })
                );
                window.mediaFrames.push({
                  ms: performance.now() - start,
                  ghosts,
                  pending: row?.hasAttribute('data-pending-ask'),
                  rowVisibility: row ? getComputedStyle(row).visibility : null,
                  targets: keys.map((key) => box(row?.querySelector(`[data-flight="${key}"]`))),
                  bubble: !!row?.querySelector('.neo-message-bubble'),
                  words: !!document.querySelector('[data-flight-words]'),
                  distance: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
                });
                if (performance.now() - start < 1800) requestAnimationFrame(frame);
              }, 0);
            requestAnimationFrame(frame);
          }, keys);
          delay = acceptDelay;
          await send();
          await page.waitForTimeout(150);
          const label = `${touch ? 'touch' : 'fine'}-${width}-${mode}-${acceptDelay}`;
          await page.screenshot({ path: join(out, `mid-${label}.png`) });
          await page.waitForTimeout(1750);
          delay = 0;
          const frames = await page.evaluate(() => window.mediaFrames);
          results.push({ width, touch, mode, acceptDelay, keys, sources, frames });
          writeFileSync(join(out, 'evidence.json'), JSON.stringify(results, null, 2));
          await page.screenshot({ path: join(out, `landed-${label}.png`) });
          const moving = frames.filter(
            (f) => f.ghosts.length && f.ghosts.every((g) => g.visibility === 'visible')
          );
          assert(moving.length > 10, 'Photos/files never flew across enough frames');
          assert.deepEqual(
            moving[0].ghosts.map((g) => g.key),
            keys,
            'Media order changed'
          );
          assert(
            moving.every((f) => f.rowVisibility === 'hidden'),
            'Flight exposed its destination'
          );
          assert(moving.at(-1).ms - moving[0].ms > 450, 'Media flight ended early');
          if (acceptDelay === 250)
            assert(
              moving.some((f) => f.pending) && moving.some((f) => f.pending === false),
              'No mid-flight row replacement'
            );
          else
            assert(
              frames.find((f) => f.pending === false).ms > moving.at(-1).ms,
              'Acceptance did not follow landing'
            );
          const last = moving.at(-1);
          last.ghosts.forEach((ghost) => {
            assert(ghost.target, 'Media lost its destination');
            for (const key of ['x', 'y', 'width', 'height'])
              assert(
                Math.abs(ghost.box[key] - ghost.target[key]) < 5,
                `Media missed its target ${key}`
              );
            assert(Math.abs(ghost.radius - 12) < 0.1);
          });
          assert(
            moving.every((f) => f.words === (mode === 'mixed')),
            'Media-only send grew a words ghost'
          );
          const settled = frames.filter((f) => f.ms > 650 && f.targets.every(Boolean));
          assert(
            settled.length > 10 && settled.every((f) => f.distance < 3),
            'Media send lost its bottom pin'
          );
          assert(
            settled.every((f) => f.bubble === (mode === 'mixed')),
            'Media-only send grew a bubble'
          );
          keys.forEach((key, index) => {
            for (const coordinate of ['x', 'y', 'width', 'height'])
              assert(
                Math.abs(
                  settled[0].targets[index][coordinate] - settled.at(-1).targets[index][coordinate]
                ) < 3,
                `${key} jumped after landing`
              );
          });
          const row = page.locator('[data-public-entry].neo-message-user').last();
          if (mode !== 'photo-only') {
            await row.getByRole('button', { name: 'Open file: notes.txt', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: 'notes.txt', exact: true });
            await dialog.waitFor();
            assert.equal(await dialog.locator('pre').textContent(), file.buffer.toString());
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'detached' });
          } else {
            await row.getByRole('button', { name: 'Open attached photo 1', exact: true }).click();
            const dialog = page.getByRole('dialog', { name: 'Attached photo 1' });
            await dialog.waitFor();
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'detached' });
          }
        }
    }
    await context.close();
  }
  console.log(
    'PASS: photo/file and mixed flights survive pending replacement and delayed acceptance, landing without jumps at 1280/390px with fine/coarse pointers'
  );
} finally {
  for (const timer of timers) clearTimeout(timer);
  await browser.close();
}
