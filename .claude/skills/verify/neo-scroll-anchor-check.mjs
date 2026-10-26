import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory, mode = 'verify'] = process.argv.slice(2);
assert(port && directory, 'usage: neo-scroll-anchor-check.mjs <port> <run-dir> [reproduce|verify]');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const rpc = (name, data = {}) =>
  JSON.parse(
    execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(data)], {
      env: { ...process.env, VERIFY_PORT: port },
      encoding: 'utf8',
    })
  ).reply;
const opened = rpc('neo.open');
assert(opened.ok, JSON.stringify(opened));
const root = opened.sessionId;
const conversationId = root.slice(4);
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;
const insertPublication = (label, lines, minutesAgo = 0) => {
  const id = crypto.randomUUID();
  const paragraphs = Array.from(
    { length: lines },
    (_, i) => `${label} paragraph ${i + 1}: ${'stable synthetic scroll anchor content. '.repeat(6)}`
  );
  const text = paragraphs.join('\n\n');
  const payload = {
    conversationId,
    publicationId: id,
    askOrigin: { sessionId: root, messageId: crypto.randomUUID() },
    producerInput: { sessionId: root, messageId: crypto.randomUUID() },
    shortText: text.slice(0, 1800),
    fullText: text,
    links: [],
  };
  execFileSync('sqlite3', [
    `${run}/data/daemon.db`,
    `INSERT INTO neo_publications(conversation_id,publication_id,payload_json,created_at) VALUES (${sqlString(conversationId)},${sqlString(id)},${sqlString(JSON.stringify(payload))},${sqlString(new Date(Date.now() - minutesAgo * 60000).toISOString())});`,
  ]);
  return id;
};
const seeded = [];
for (let i = 0; i < 30; i++) seeded.push(insertPublication(`Seeded report ${i}`, 4, 60 - i));
const editPayload = (publicationId, lines) => {
  const paragraphs = Array.from(
    { length: lines },
    (_, i) => `Edited report paragraph ${i + 1}: ${'edited synthetic content above the anchor. '.repeat(6)}`
  );
  const text = paragraphs.join('\n\n');
  const payload = {
    conversationId,
    publicationId,
    askOrigin: { sessionId: root, messageId: crypto.randomUUID() },
    producerInput: { sessionId: root, messageId: crypto.randomUUID() },
    shortText: text.slice(0, 1800),
    fullText: text,
    editedAt: new Date().toISOString(),
    links: [],
  };
  execFileSync('sqlite3', [
    `${run}/data/daemon.db`,
    `UPDATE neo_publications SET payload_json = ${sqlString(JSON.stringify(payload))} WHERE publication_id = ${sqlString(publicationId)};`,
  ]);
};
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}),
});
const evidence = `${run}/evidence`;
mkdirSync(evidence, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width > 1000 ? 900 : 780 },
    });
    let socket;
    await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`, (ws) => {
      socket = ws;
      const server = ws.connectToServer();
      server.onMessage((message) => setTimeout(() => ws.send(message), 30));
    });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    await page.waitForFunction(() => {
      const scroller = [...document.querySelectorAll('.neo-chat-rail, .neo-scroll')].find(
        (el) => el.scrollHeight > el.clientHeight + 1
      );
      return scroller && scroller.querySelectorAll('[data-public-entry]').length >= 30;
    });
    await page.waitForTimeout(1200);
    const send = (method, data) =>
      socket.send(
        JSON.stringify({
          id: crypto.randomUUID(),
          type: 'EVENT',
          sessionId: 'global',
          method,
          data,
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        })
      );
    const setup = await page.evaluate(() => {
      const scroller = [...document.querySelectorAll('.neo-chat-rail, .neo-scroll')].find(
        (el) => el.scrollHeight > el.clientHeight + 1
      );
      const entries = [...scroller.querySelectorAll('[data-public-entry]')];
      const anchor = entries[8];
      const key = anchor.getAttribute('data-public-entry');
      const scrollerRect = scroller.getBoundingClientRect();
      scroller.scrollTop +=
        anchor.getBoundingClientRect().top - scrollerRect.top - scroller.clientHeight * 0.35;
      window.__scroller = scroller;
      window.__anchorKey = key;
      window.__measure = { baseline: null, maxDelta: 0, frames: 0 };
      window.__sampling = true;
      const tick = () => {
        const m = window.__measure;
        const el = document.querySelector(`[data-public-entry="${window.__anchorKey}"]`);
        if (el && m) {
          const top = el.getBoundingClientRect().top;
          if (m.baseline === null) m.baseline = top;
          m.maxDelta = Math.max(m.maxDelta, Math.abs(top - m.baseline));
          m.frames++;
        }
        if (window.__sampling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return {
        key,
        entries: entries.length,
        scroller: scroller.classList.contains('neo-chat-rail') ? 'rail' : 'main',
      };
    });
    assert(setup, 'expected a scrollable conversation with an anchor entry');
    await page.waitForTimeout(400);
    const reset = () =>
      page.evaluate(() => {
        const el = document.querySelector(`[data-public-entry="${window.__anchorKey}"]`);
        window.__measure = {
          baseline: el ? el.getBoundingClientRect().top : null,
          maxDelta: 0,
          frames: 0,
        };
      });
    const measure = async (label) => {
      const m = await page.evaluate(() => window.__measure);
      return { burst: label, maxDeltaPx: Math.round(m.maxDelta * 100) / 100, frames: m.frames };
    };
    await page.screenshot({ path: `${evidence}/neo-scroll-anchor-${width}-${mode}-anchored.png` });
    await reset();
    for (let i = 0; i < 10; i++) {
      send('neo.changed', {});
      await sleep(150);
    }
    await sleep(500);
    const refresh = await measure('refresh');
    await reset();
    for (let i = 0; i < 6; i++) {
      insertPublication(`Appended report ${i}`, 4);
      send('neo.changed', {});
      await sleep(250);
    }
    await sleep(500);
    const appends = await measure('appends');
    await page.screenshot({ path: `${evidence}/neo-scroll-anchor-${width}-${mode}-burst.png` });
    await reset();
    editPayload(seeded[2], 16);
    send('neo.publications.changed', { conversationId });
    await sleep(1000);
    const edits = await measure('edit-above-anchor');
    const follow = await page.evaluate(() => {
      const s = window.__scroller;
      s.scrollTop = s.scrollHeight;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });
    assert(follow < 2, `could not scroll to the bottom: ${follow}`);
    await page.waitForTimeout(400);
    insertPublication('Follow check', 3);
    send('neo.changed', {});
    await sleep(900);
    const bottomGap = await page.evaluate(() => {
      const s = window.__scroller;
      return s.scrollHeight - s.scrollTop - s.clientHeight;
    });
    results.push({
      width,
      ...setup,
      bursts: [refresh, appends, edits],
      bottomGapPx: Math.round(bottomGap * 100) / 100,
    });
    await page.close();
  }
  writeFileSync(`${evidence}/neo-scroll-anchor-${mode}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (mode === 'verify') {
    for (const result of results) {
      for (const burst of result.bursts)
        assert(
          burst.maxDeltaPx <= 2,
          `${result.width}px ${burst.burst}: anchor moved ${burst.maxDeltaPx}px while scrolled up`
        );
      assert(
        result.bottomGapPx < 160,
        `${result.width}px: view did not follow new content at the bottom (${result.bottomGapPx}px gap)`
      );
    }
  } else {
    assert(
      results.some((result) => result.bursts.some((burst) => burst.maxDeltaPx > 2)),
      'Must reproduce the anchor movement while scrolled up'
    );
  }
} finally {
  await browser.close();
}
