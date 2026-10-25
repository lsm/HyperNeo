import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory, mode = 'verify'] = process.argv.slice(2);
assert(port && directory, 'usage: neo-animation-check.mjs <port> <run-dir> [reproduce|verify]');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
const rpc = (name, data = {}) => JSON.parse(execFileSync('bun', [
  '.claude/skills/verify/rpc.ts', name, JSON.stringify(data),
], { env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8' })).reply;
const opened = rpc('neo.open');
assert(opened.ok, JSON.stringify(opened));
assert(opened.todoAsks?.some((entry) => entry.todos.some((todo) => todo.state === 'doing')),
  'Seed doing todos before launching this journey');
const root = opened.sessionId;
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;
for (let i = 0; i < 18; i++) {
  const id = crypto.randomUUID();
  const payload = {
    conversationId: root.slice(4), publicationId: id,
    askOrigin: { sessionId: root, messageId: crypto.randomUUID() },
    producerInput: { sessionId: root, messageId: crypto.randomUUID() },
    shortText: `Synthetic animation report ${i}: ${'Stable message content. '.repeat(12)}`,
    fullText: 'Synthetic verification only.', links: [],
  };
  execFileSync('sqlite3', [`${run}/data/daemon.db`,
    `INSERT INTO neo_publications(conversation_id,publication_id,payload_json,created_at) VALUES (${sqlString(root.slice(4))},${sqlString(id)},${sqlString(JSON.stringify(payload))},${sqlString(new Date().toISOString())});`,
  ]);
}
rpc('rpc:settings.global.update', { updates: { voice: {
  enabled: true, endpoint: `http://127.0.0.1:${port}/synthetic-asr`, model: 'synthetic',
} } });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, args: [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
], ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = `${run}/evidence`;
mkdirSync(evidence, { recursive: true });
const results = [];
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, permissions: ['microphone'] });
    await page.addInitScript(() => {
      window.samples = [];
      AnalyserNode.prototype.getByteTimeDomainData = function (buffer) {
        window.samples.push(performance.now());
        const level = 15 + 12 * Math.sin(performance.now() / 110);
        for (let i = 0; i < buffer.length; i++) buffer[i] = 128 + Math.sin(i) * level;
      };
    });
    let socket;
    await page.routeWebSocket(`ws://127.0.0.1:${port}/ws`, (ws) => {
      socket = ws;
      ws.connectToServer();
    });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    await page.locator('[data-public-entry]').last().waitFor();
    await page.waitForTimeout(1000);
    const measure = () => page.evaluate(() => {
      const rail = document.querySelector('.neo-chat-rail');
      const entry = rail.querySelector('[data-public-entry]:last-of-type');
      return { height: rail.getBoundingClientRect().height, messageY: entry.getBoundingClientRect().y };
    });
    const boxes = [await measure()];
    await page.evaluate(() => {
      window.railResizes = 0;
      const rail = document.querySelector('.neo-chat-rail');
      const observer = new ResizeObserver(() => window.railResizes++);
      observer.observe(rail);
      for (const child of rail.children) observer.observe(child);
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => { window.railResizes = 0; });
    for (const active of [true, false, true, false]) {
      socket.send(JSON.stringify({ id: crypto.randomUUID(), type: 'EVENT', sessionId: 'global',
        method: 'neo.working', data: { working: active ? [{ sessionId: root, projectId: null, title: 'Neo', status: 'processing' }] : [] },
        timestamp: new Date().toISOString(), version: '1.0.0',
      }));
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.neo-progress:visible').count(), 0);
      assert.equal(await page.locator('.neo-progress-slot, .neo-activity').count(), 0);
      if (active) await page.screenshot({ path: `${evidence}/neo-mid-turn-${width}.png` });
      boxes.push(await measure());
    }
    const railResizes = await page.evaluate(() => window.railResizes);
    await page.getByRole('button', { name: 'Start voice input', exact: true }).click();
    await page.getByTestId('voice-bars').locator('div').first().waitFor();
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.samples = []; });
    const frames = await page.evaluate(() => new Promise((done) => {
      const intervals = [];
      let previous = performance.now();
      const until = previous + 1800;
      function frame(now) {
        intervals.push(now - previous);
        previous = now;
        if (now < until) requestAnimationFrame(frame);
        else done(intervals);
      }
      requestAnimationFrame(frame);
    }));
    const samples = await page.evaluate(() => window.samples);
    const gaps = samples.slice(1).map((time, i) => time - samples[i]).sort((a, b) => a - b);
    await page.screenshot({ path: `${evidence}/neo-animation-${width}.png` });
    await page.getByRole('button', { name: 'Cancel recording', exact: true }).click();
    results.push({ width, boxes, railResizes,
      heightMovement: Math.max(...boxes.map((b) => b.height)) - Math.min(...boxes.map((b) => b.height)),
      messageMovement: Math.max(...boxes.map((b) => b.messageY)) - Math.min(...boxes.map((b) => b.messageY)),
      samples: samples.length, medianSampleGapMs: gaps[Math.floor(gaps.length / 2)],
      frames: frames.length, p95FrameMs: frames.sort((a, b) => a - b)[Math.floor(frames.length * 0.95)],
    });
    await page.close();
  }
  writeFileSync(`${evidence}/neo-animation-${mode}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (mode === 'verify') {
    assert(results.every((r) => r.heightMovement < 1 && r.messageMovement < 1 && r.railResizes === 0), 'Busy toggles must not resize or move the conversation');
    assert(results.every((r) => r.samples > 60 && r.medianSampleGapMs < 25), 'Voice must sample smoothly at normal display cadence');
  } else {
    assert(results.every((r) => r.messageMovement > 10 && r.medianSampleGapMs > 35), 'Must reproduce both regressions');
  }
} finally {
  await browser.close();
}
