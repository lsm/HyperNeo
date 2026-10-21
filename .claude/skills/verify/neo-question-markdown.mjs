import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-question-markdown.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
const rpc = (name) => JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, '{}'], {
  env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
})).reply;
const opened = rpc('neo.open');
assert(opened.ok);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const ask = crypto.randomUUID();
const text = [
  'Synthetic decision', 'Please review **bold decision** and `inline code`.', '',
  '- First item', '- Second item', '',
  '| Option | Result |', '| --- | --- |', '| One | Ready |', '',
  '[Safe link](https://example.com/verify)', '',
  '```text', 'synthetic code', '```', '',
  '<script>window.questionInjected = true</script>',
  '<b data-question-injected>Raw HTML</b>',
].join('\n');
const ids = Object.fromEntries(['open', 'answered', 'retired'].map((state) => [state, crypto.randomUUID()]));
const now = Date.now();
let sql = `INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},'Synthetic Markdown questions','Synthetic verification only','open',${now},${now});`;
for (const [state, id] of Object.entries(ids)) {
  sql += `INSERT INTO neo_questions(id,ask_id,text,kind,state,answer,answered_by,answered_at,retired_reason,created_at,no_label,yes_label) VALUES(${quote(id)},${quote(ask)},${quote(text)},'yesno',${quote(state)},${state === 'answered' ? quote('"yes"') : 'NULL'},${state === 'answered' ? "'button'" : 'NULL'},${state === 'answered' ? now : 'NULL'},${state === 'retired' ? "'Synthetic retirement'" : 'NULL'},${now},'Keep old','Use new');`;
}
execFileSync('sqlite3', [`${run}/data/daemon.db`, sql]);
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
    await card.locator('[data-ask-details-toggle]').click();
    const questions = [];
    for (const [state, id] of Object.entries(ids)) {
      const body = card.locator(`[id="neo-ref-question-${id}"]`);
      await body.locator('table').waitFor();
      assert.equal(await body.locator('strong').innerText(), 'bold decision');
      assert.equal(await body.locator('ul li').count(), 2);
      assert(await body.locator('br').count() > 0);
      assert.equal(await body.locator('pre code.language-text').innerText(), 'synthetic code\n');
      assert.equal(await body.locator('a').getAttribute('href'), 'https://example.com/verify');
      assert.equal(await body.locator('script, [data-question-injected]').count(), 0);
      const bounds = await body.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      questions.push({ state, bounds, lists: 2, table: true, bold: true, lineBreaks: true, rawHtmlEscaped: true });
    }
    assert.equal(await page.evaluate(() => window.questionInjected), undefined);
    assert(await card.getByRole('button', { name: 'Use new', exact: true }).isEnabled());
    assert((await card.locator(`[id="neo-ref-question-${ids.answered}"]`).innerText()).includes('Use new'));
    assert((await card.locator(`[id="neo-ref-question-${ids.retired}"]`).innerText()).includes('Synthetic retirement'));
    await page.screenshot({ path: `${run}/evidence/neo-question-markdown-${width}.png`, fullPage: true });
    results.push({ width, questions });
    await page.close();
  }
  writeFileSync(`${run}/evidence/neo-question-markdown.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
