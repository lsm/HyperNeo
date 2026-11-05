import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-open-questions.mjs <port> <run-dir>');
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
execFileSync('sqlite3', [`${run}/data/daemon.db`, `INSERT INTO neo_asks(id,session_id,title,request,status,outcome,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},'Synthetic collapsed questions','Synthetic verification only','open','Synthetic history',${now},${now});`]);
const questions = ['First decision', 'Second decision'].map((text) => {
  const receipt = rpc('neo.question.ask', { retireWhen: { pack: 'core', kind: 'evidence', params: { path: `${run}/question-no-longer-needed` } }, askId: ask, kind: 'yesno', text, noLabel: 'Wait', yesLabel: 'Proceed' });
  assert(receipt.ok, JSON.stringify(receipt));
  return receipt.question.id;
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
    for (const id of questions) {
      const body = card.locator(`[data-ask-question="${id}"]`);
      await body.waitFor();
      assert(await body.getByRole('button', { name: 'Proceed', exact: true }).isEnabled());
      assert(await body.getByRole('button', { name: 'Wait', exact: true }).isEnabled());
      await page.waitForFunction(({ id, width }) => {
        const box = document.getElementById(`neo-ref-question-${id}`).getBoundingClientRect();
        return box.x >= 0 && box.right <= width + 1;
      }, { id, width });
      const bounds = await body.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    }
    assert.equal(await card.locator('[data-ask-details]').count(), 0);
    await card.locator('[data-ask-details-toggle]').click();
    await card.locator('[data-ask-details-toggle]').click();
    assert.equal(await card.locator('[data-ask-details]').count(), 0);
    assert.equal(await card.locator('[data-ask-question]').count(), 2);
    await page.screenshot({ path: `${run}/evidence/open-questions-${width}.png`, fullPage: true });
    if (width === 390) {
      for (const id of questions) {
        await card.locator(`[data-ask-question="${id}"]`).getByRole('button', { name: 'Proceed', exact: true }).click();
        await card.locator(`[data-ask-question="${id}"]`).waitFor({ state: 'detached' });
        const answer = rpc('neo.question.get', { questionId: id });
        assert.equal(answer.question.state, 'answered');
        assert.equal(answer.question.answer, 'yes');
        assert.equal(answer.answeredByHuman, true);
      }
      assert.equal(await card.locator('[data-ask-details]').count(), 0);
    }
    results.push({ width, questions: 2, collapsed: true, controlsEnabled: true, answered: width === 390 });
    await page.close();
  }
  writeFileSync(`${run}/evidence/open-questions.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
