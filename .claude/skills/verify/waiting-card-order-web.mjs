import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const [port, run, phase = 'after'] = process.argv.slice(2);
assert(port && run && ['before', 'after'].includes(phase));
assert.notEqual(String(port), '8399');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const out = `${run}/evidence/${phase}`;
mkdirSync(out, { recursive: true });
const expectedCards = ['waiting-old-question', 'waiting-old-early', 'waiting-b-report', 'waiting-b-question', 'waiting-a-question', 'waiting-a-held'];
const waitingAsks = ['waiting-old', 'waiting-b', 'waiting-a'];
const observations = [];
const daemonQueue = () => {
  const output = execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'neo.snapshot', '{}'], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_PORT: String(port), HYPERNEO_DATA_DIR: `${run}/data` },
  });
  const find = value => value && typeof value === 'object'
    ? (value.humanQueue ?? Object.values(value).map(find).find(Boolean)) : undefined;
  const queue = find(JSON.parse(output).reply);
  assert(queue, 'the snapshot carries the human queue');
  return {
    cards: queue.items.filter(item => 'questionId' in item).map(item => item.questionId),
    uncoveredTodos: queue.items.filter(item => 'todoId' in item).map(item => item.todoId),
  };
};
const pair = async (page) => {
  const code = execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic order browser' })], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_PORT: String(port), HYPERNEO_DATA_DIR: `${run}/data` },
  }).match(/"code":\s*"([^"]+)"/)?.[1];
  assert(code, 'no pairing code');
  await page.goto(`http://127.0.0.1:${port}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
};
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', isMobile: width < 800 });
    try {
      const page = await context.newPage();
      await pair(page);
      await page.goto(`http://127.0.0.1:${port}/neo`);
      const openWork = async () => {
        if (width < 800) await page.getByRole('button', { name: /^Your work/ }).click();
        await page.locator(phase === 'after' ? '[data-human-queue]:visible [data-queue-ask="waiting-a"]' : '[data-ask="waiting-a"]:visible').waitFor();
        await page.evaluate(async () => {
          await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
        });
      };
      const shown = (selector, attribute) => page.locator(`${selector}:visible`).evaluateAll((nodes, name) => nodes.map(node => name ? node.getAttribute(name) : node.id.replace('neo-ref-question-', '')), attribute);
      const queueOrder = async () => {
        const asks = await shown('[data-human-queue] [data-queue-ask]', 'data-queue-ask');
        const queueCards = await shown('[data-human-queue] [id^="neo-ref-question-"]');
        const todos = await shown('[data-human-queue] [data-ask-todo]', 'data-ask-todo');
        return { asks, queueCards, todos };
      };
      const order = () => phase === 'after' ? queueOrder() : shown('[data-ask]', 'data-ask');
      const cardOrder = () => shown('[id^="neo-ref-question-"]');
      await openWork();
      const initial = await order();
      const cards = phase === 'after' ? initial.queueCards : await cardOrder();
      if (phase !== 'after') assert.equal(await page.locator('[data-ask="waiting-a"]:visible').getByText('Waiting on you', { exact: true }).count(), 1);
      const show = (selector, block) => page.locator(`${selector}:visible`).first().evaluate((node, at) => node.scrollIntoView({ block: at }), block);
      const report = page.locator('#neo-ref-question-waiting-b-report:visible').first();
      let tail = false;
      for (let attempt = 0; attempt < 20 && !tail; attempt++) {
        await report.getByRole('button', { name: 'View full report' }).click();
        tail = (await page.getByRole('dialog').innerText()).includes('TAIL-OF-REPORT');
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        if (!tail) await page.waitForTimeout(250);
      }
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate(() => document.querySelectorAll('*').forEach((node) => { if (node.scrollTop) node.scrollTop = 0; }));
        await page.screenshot({ path: `${out}/waiting-order-${width}-${scheme}-top.png` });
        await show('#neo-ref-question-waiting-a-held', 'center');
        await page.screenshot({ path: `${out}/waiting-order-${width}-${scheme}-held.png` });
        await show(phase === 'after' ? '[data-queue-ask="blocked"]' : '[data-scene-group="attention"]', 'start');
        await page.screenshot({ path: `${out}/waiting-order-${width}-${scheme}-asks.png` });
        if (!tail) continue;
        await report.getByRole('button', { name: 'View full report' }).click();
        await page.getByRole('dialog').getByText('TAIL-OF-REPORT').evaluate((node) => node.scrollIntoView({ block: 'end' }));
        await page.getByRole('dialog').getByText('TAIL-OF-REPORT').waitFor({ state: 'visible' });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${out}/waiting-order-${width}-${scheme}-report.png` });
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
      }
      await page.emulateMedia({ colorScheme: 'light' });
      execFileSync('bun', ['.claude/skills/verify/waiting-card-order-seed.ts', run, 'update'], {
        env: { PATH: process.env.PATH, HOME: `${run}/home`, HYPERNEO_DATA_DIR: `${run}/data`, NODE_ENV: 'test' },
      });
      await page.reload();
      await openWork();
      const reloaded = await order();
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      observations.push({ width, initial, reloaded, cards, tail, fits });
      writeFileSync(`${out}/waiting-order.json`, JSON.stringify(observations, null, 2));
      assert(fits, 'no horizontal overflow');
      if (phase === 'after') {
        assert.deepEqual(reloaded, initial, 'unrelated status update and reload keep the same order');
        assert.deepEqual(initial.asks.slice(0, 3), waitingAsks, 'the waiting asks lead in card order');
        assert.deepEqual(initial.asks.slice(3).sort(), ['blocked', 'queued', 'running']);
        assert.equal(await page.locator('[data-scene-group="outcomes"] [data-ask="done"]').count(), 1);
        assert.deepEqual(cards, expectedCards, 'each ask shows once as its full card with held cards inline');
        const daemon = daemonQueue();
        assert.deepEqual([...reloaded.queueCards].sort(), [...daemon.cards].sort(), 'every queued card renders inside its full ask');
        assert.deepEqual(reloaded.todos.filter(id => daemon.uncoveredTodos.includes(id)), daemon.uncoveredTodos, 'work renders in the daemon queue order');
        assert(tail, 'the promoted long report opens in full');
      }
      else assert.notDeepEqual(cards, expectedCards, 'reproduce cards grouped by ask instead of by card time');
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
