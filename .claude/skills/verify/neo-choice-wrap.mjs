import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-choice-wrap.mjs <port> <run-dir>');
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
const options = [
  '保留现在的列表布局，只把每一行的间距、字号和状态标签重新调整一遍，让长标题在手机上也能完整显示而不被截断或者溢出卡片',
  'Switch every card to the compact table layout with sortable columns, sticky headers, and a much longer description that keeps going past one line',
  'https://example.test/a-very-long-unbroken-option-token-that-must-still-wrap-inside-the-card-at-phone-width',
];
const ask = crypto.randomUUID();
const ids = { single: crypto.randomUUID(), multiple: crypto.randomUUID() };
const now = Date.now();
let sql = `INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},'Synthetic choice layout','Synthetic verification only','open',${now},${now});`;
for (const [kind, id] of Object.entries(ids))
  sql += `INSERT INTO neo_questions(id,ask_id,text,kind,options,multiple,state,created_at) VALUES(${quote(id)},${quote(ask)},${quote(kind === 'single' ? 'Which layout?' : 'Which layouts should stay?')},'choice',${quote(JSON.stringify(options))},${kind === 'multiple' ? 1 : 0},'open',${now});`;
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
    await card.screenshot({ path: `${run}/evidence/neo-choice-wrap-${width}.png` });
    const pageFits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    const checked = {};
    for (const [kind, id] of Object.entries(ids)) {
      const box = card.locator(`[id="neo-ref-question-${id}"]`);
      await box.waitFor();
      const outer = await box.boundingBox();
      const rows = box.locator('[data-choice-option]');
      assert.equal(await rows.count(), 3);
      const seen = [];
      for (let index = 0; index < 3; index++) {
        const row = rows.nth(index);
        const text = await row.innerText();
        assert(text.replace(/\s+/g, '').startsWith(`${'ABC'[index]}${options[index]}`.replace(/\s+/g, '')), `${kind} ${index}: ${text}`);
        const bounds = await row.boundingBox();
        assert(bounds.x >= outer.x - 1 && bounds.x + bounds.width <= outer.x + outer.width + 1, `${kind} ${index} leaves the card at ${width}`);
        const overflow = await row.evaluate((node) => node.scrollWidth - node.clientWidth);
        assert(overflow <= 1, `${kind} ${index} overflows by ${overflow}px at ${width}`);
        seen.push({ letter: 'ABC'[index], height: Math.round(bounds.height), overflow });
      }
      checked[kind] = seen;
    }
    assert.equal(pageFits, true, `the page scrolls sideways at ${width}`);
    results.push({ width, checked });
    await page.close();
  }
  writeFileSync(`${run}/evidence/neo-choice-wrap.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
