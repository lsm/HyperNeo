import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: chat-questions-web.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
const rpc = (name, input = {}) => {
  const reply = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!reply.error, JSON.stringify(reply));
  return reply.value ?? reply;
};
const opened = rpc('neo.open');
assert(opened.ok);
const ask = crypto.randomUUID();
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now();
execFileSync('sqlite3', [`${run}/data/daemon.db`, `INSERT INTO neo_asks(id,session_id,title,request,status,outcome,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},'Synthetic chat question card','Synthetic verification only','open',NULL,${now},${now});`]);
const questions = ['Ship the synthetic draft?', 'Keep the synthetic notes?'].map((text) => {
  const receipt = rpc('neo.question.ask', { retireWhen: { pack: 'core', kind: 'evidence', params: { path: `${run}/question-no-longer-needed` } }, askId: ask, kind: 'choice', text, options: ['Proceed', 'Wait'] });
  assert(receipt.ok, JSON.stringify(receipt));
  return receipt.question.id;
});
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`;
const code = execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic chat questions browser' })], {
  encoding: 'utf8', env: { ...process.env, VERIFY_PORT: port },
}).match(/"code":\s*"([^"]+)"/)?.[1];
assert(code, 'no pairing code');
const results = [];
const chatRow = (page, id) => page.locator(`main [data-chat-question="${id}"]`);
let storageState;
const open = async (options) => {
  const context = await browser.newContext({ ...options, ...(storageState ? { storageState } : {}) });
  await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  return context.newPage();
};
try {
  const pairing = await open({});
  await pairing.goto(`${base}/pair#${code}`);
  await pairing.getByRole('button', { name: 'Pair this browser' }).click();
  await pairing.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  storageState = await pairing.context().storageState();
  await pairing.context().close();
  for (const width of [1280, 390])
    for (const colorScheme of ['light', 'dark']) {
      const page = await open({ viewport: { width, height: 900 }, colorScheme });
      await page.goto(`${base}/neo`);
      for (const id of questions) {
        const row = chatRow(page, id);
        await row.waitFor();
        assert(await row.locator('[data-choice-option]', { hasText: 'Proceed' }).isEnabled());
        const box = await row.boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width + 1, `row fits at ${width}`);
        assert.equal(await page.locator(`#neo-ref-question-${id}`).count(), 1);
      }
      await chatRow(page, questions[1]).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${run}/evidence/chat-questions-${width}-${colorScheme}.png` });
      results.push({ width, colorScheme, shownInChat: questions.length });
      await page.context().close();
    }
  const page = await open({ viewport: { width: 390, height: 900 } });
  await page.goto(`${base}/neo`);
  await chatRow(page, questions[0]).locator('button', { hasText: 'Synthetic chat question card' }).click();
  await page.locator(`#neo-ref-question-${questions[0]}`).waitFor({ state: 'visible' });
  results.push({ titleOpensInbox: true });
  await page.goto(`${base}/neo`);
  await chatRow(page, questions[0]).locator('[data-choice-option]', { hasText: 'Proceed' }).click();
  await chatRow(page, questions[0]).waitFor({ state: 'detached' });
  const answer = rpc('neo.question.get', { questionId: questions[0] });
  assert.equal(answer.question.state, 'answered');
  assert.deepEqual(answer.question.answer, ['Proceed']);
  assert.equal(answer.answeredByHuman, true);
  results.push({ answeredInChat: questions[0], leftChat: true });
  await chatRow(page, questions[1]).getByRole('button', { name: 'Hold' }).click();
  await chatRow(page, questions[1]).waitFor({ state: 'detached' });
  const held = rpc('neo.question.get', { questionId: questions[1] });
  assert.equal(held.question.state, 'open');
  assert(held.question.heldAt, 'hold recorded');
  results.push({ heldInChat: questions[1], leftChat: true });
  await page.screenshot({ path: `${run}/evidence/chat-questions-after.png` });
  writeFileSync(`${run}/evidence/chat-questions.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
