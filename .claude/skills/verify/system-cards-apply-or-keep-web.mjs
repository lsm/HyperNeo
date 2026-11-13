import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: system-cards-apply-or-keep-web.mjs <port> <run-dir>');
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
const ask = crypto.randomUUID();
const now = Date.now();
execFileSync('sqlite3', [`${run}/data/daemon.db`, `INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES('${ask}','${opened.sessionId}','Synthetic settings','Synthetic verification only','open',${now},${now});`]);
const setting = { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/web' }, key: 'mergePolicy' };
const { questionId } = rpc('pack.preferences.ask', { askId: ask, requestId: 'web', values: [{ ...setting, value: 'ci_only' }] });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const result = {};
try {
  const code = rpc('device.pair.create', { kind: 'human', name: 'Synthetic settings browser' }).code;
  assert(code, 'no pairing code');
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
  await page.goto(`http://127.0.0.1:${port}/neo`);
  await page.getByRole('button', { name: /^Your work/ }).click();
  const card = page.locator(`[data-ask="${ask}"]:visible`);
  await card.waitFor();
  const body = card.locator(`[id="neo-ref-question-${questionId}"]`);
  await body.waitFor();
  result.options = await body.locator('[data-choice-option]').allTextContents();
  result.yesNoButtons = await body.getByRole('button', { name: /^(Yes|No)$/ }).count();
  await page.waitForFunction(() => Math.abs(document.querySelector('.neo-scene-sheet').getBoundingClientRect().x) < 0.1);
  await page.screenshot({ path: `${run}/evidence/system-cards-apply-or-keep-web.png`, fullPage: true });
  await body.getByRole('button', { name: 'A Apply these settings', exact: true }).click();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !result.saved; i++) {
    result.saved = rpc('pack.preferences.get', setting).preference?.value ?? null;
    if (!result.saved) await new Promise((done) => setTimeout(done, 100));
  }
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/system-cards-apply-or-keep-web.json`, JSON.stringify(result, null, 2));
}
assert.deepEqual(result.options, ['AApply these settings', 'BKeep current settings']);
assert.equal(result.yesNoButtons, 0);
assert.equal(result.saved, 'ci_only');
console.log(`PASS: the web card shows A Apply these settings and B Keep current settings with no yes/no buttons, and tapping A saves the setting. ${run}/evidence/system-cards-apply-or-keep-web.json`);
