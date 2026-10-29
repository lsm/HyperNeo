import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

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
assert(prompt.includes('For neo.question.ask text and publication shortText, use Markdown'));
const guidance = rpc('operations.describe', { name: 'neo.question.ask' });
assert(JSON.stringify(guidance).includes('short title line, a few bullets or a small table, bold key choice'));
const fixtures = JSON.parse(readFileSync('packages/web/src/neo/__tests__/fixtures/question-guidance.json', 'utf8'));
const opened = rpc('neo.open');
assert(opened.ok);
const ask = crypto.randomUUID();
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now();
execFileSync('sqlite3', [`${run}/data/daemon.db`, `INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},'Synthetic guidance examples','Synthetic verification only','open',${now},${now});`]);
const questions = fixtures.map((fixture) => {
      const receipt = rpc('neo.question.ask', { retireWhen: { pack: 'core', kind: 'evidence', params: { path: `${run}/question-no-longer-needed` } }, askId: ask, kind: 'yesno', text: fixture.text, noLabel: 'Release now', yesLabel: 'Preview first' });
      assert(receipt.ok, JSON.stringify(receipt));
      return { ...fixture, id: receipt.question.id };
    });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const results = [];
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    if (width === 390) await page.getByRole('button', { name: /^Your work/ }).click();
    const card = page.locator(`[data-ask="${ask}"]:visible`);
    await card.waitFor();
    for (const fixture of questions) {
      const body = card.locator(`[id="neo-ref-question-${fixture.id}"]`);
      await body.locator('strong').waitFor();
      assert.equal(await body.locator('strong').innerText(), fixture.keyChoice);
      assert.equal(await body.locator('p').first().innerText(), fixture.title);
      assert.equal(await body.locator('ul li').count(), fixture.bullets);
      assert.equal(await body.locator('table tr').count(), fixture.tableRows);
      assert(await body.getByRole('button', { name: 'Preview first', exact: true }).isEnabled());
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
      await card.locator(`[id="neo-ref-question-${questions[0].id}"]`).getByRole('button', { name: 'Preview first', exact: true }).click();
      await card.locator('[data-ask-details-toggle]').click();
      await card.locator(`[id="neo-ref-question-${questions[0].id}"] strong`).waitFor();
      assert((await card.locator(`[id="neo-ref-question-${questions[0].id}"]`).innerText()).includes('Preview first'));
      answered = rpc('neo.question.get', { questionId: questions[0].id });
      assert.equal(answered.question.state, 'answered');
      assert.equal(answered.question.answer, 'yes');
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
