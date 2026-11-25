import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { revealAsk } from './queue-ask.mjs';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-question-guidance.mjs <port> <run-dir>');
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
const prompt = execFileSync('bun', ['-e', "import {neoPrompt} from './packages/daemon/src/lib/neo/prompt.ts'; console.log(neoPrompt([]));"], { encoding: 'utf8' });
assert(!prompt.includes('a few bullets or a small comparison table'));
const guidance = rpc('operations.describe', { name: 'neo.question.ask' });
assert.equal(guidance.found, true);
for (const phrase of ['short Markdown title', 'a few bullets or a small table', 'bold the key choice']) {
  assert(guidance.description.includes(phrase), phrase);
}
const fixtures = JSON.parse(readFileSync('packages/web/src/neo/__tests__/fixtures/question-guidance.json', 'utf8'));
const opened = rpc('neo.open');
assert(opened.ok);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now();
const questions = fixtures.map((fixture) => {
      const ask = crypto.randomUUID();
      execFileSync('sqlite3', [`${run}/data/daemon.db`, `INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},'Synthetic guidance examples','Synthetic verification only','open',${now},${now});`]);
      const receipt = rpc('neo.question.ask', { retireWhen: { pack: 'core', kind: 'evidence', params: { path: `${run}/question-no-longer-needed` } }, askId: ask, kind: 'choice', text: fixture.text, options: ['Release now', 'Preview first'] });
      assert(receipt.ok, JSON.stringify(receipt));
      return { ...fixture, ask, id: receipt.question.id };
    });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const base = `http://127.0.0.1:${port}`;
const results = [];
try {
  const context = await browser.newContext();
  const { code } = rpc('device.pair.create', { kind: 'human', name: 'Synthetic question browser' });
  assert(code);
  const paired = await context.request.post(`${base}/pair`, { headers: { origin: base }, data: { code, name: 'Synthetic question browser' } });
  assert.equal(paired.status(), 200);
  for (const width of [1280, 390]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width === 390) await page.getByRole('button', { name: /^Your work/ }).click();
    for (const fixture of questions) {
      const card = await revealAsk(page, fixture.ask);
      await card.waitFor();
      const body = card.locator(`[id="neo-ref-question-${fixture.id}"]`);
      await body.locator('strong').waitFor();
      assert.equal(await body.locator('strong').innerText(), fixture.keyChoice);
      assert.equal(await body.locator('p').first().innerText(), fixture.title);
      assert.equal(await body.locator('ul li').count(), fixture.bullets);
      assert.equal(await body.locator('table tr').count(), fixture.tableRows);
      assert(await body.locator('[data-choice-option]', { hasText: 'Preview first' }).isEnabled());
      await page.waitForFunction(({ id, width }) => {
        const box = document.getElementById(`neo-ref-question-${id}`).getBoundingClientRect();
        return box.x >= 0 && box.right <= width + 1;
      }, { id: fixture.id, width });
      const bounds = await body.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    }
    if (width === 390) await page.waitForFunction(() => Math.abs(document.querySelector('.neo-scene-sheet').getBoundingClientRect().x) < 0.1);
    await page.screenshot({ path: `${run}/evidence/neo-question-guidance-${width}.png`, fullPage: true });
    let answered = null;
    if (width === 390) {
      const card = await revealAsk(page, questions[0].ask);
      await card.locator(`[id="neo-ref-question-${questions[0].id}"]`).locator('[data-choice-option]', { hasText: 'Preview first' }).click();
      await card.locator('[data-ask-details-toggle]').click();
      const detail = page.getByRole('dialog').locator(`[id="neo-ref-question-${questions[0].id}"]`);
      await detail.locator('strong').waitFor();
      assert((await detail.innerText()).includes('Preview first'));
      answered = rpc('neo.question.get', { questionId: questions[0].id });
      assert.equal(answered.question.state, 'answered');
      assert.deepEqual(answered.question.answer, ['Preview first']);
      assert.equal(answered.answeredByHuman, true);
    }
    results.push({ width, questions, answered });
    await page.close();
  }
  writeFileSync(`${run}/evidence/neo-question-guidance.json`, JSON.stringify({ prompt, guidance, results }, null, 2));
  console.log(JSON.stringify(results.map(({ width, answered }) => ({ width, state: answered?.question.state ?? 'open', answer: answered?.question.answer ?? null })), null, 2));
} finally {
  await browser.close();
}
