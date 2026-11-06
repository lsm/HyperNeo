import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: session-message-window.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const rpc = (name, input = {}) => JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
  env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
})).reply;
const sql = (value) => execFileSync('sqlite3', [`${run}/data/daemon.db`, value], { encoding: 'utf8' });
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

const created = rpc('rpc:session.create', { workspacePath: `${run}/home`, title: 'Window check' });
const sessionId = created.sessionId;
assert(sessionId, JSON.stringify(created));
const base = Date.now() - 200_000;
let seed = '';
for (let i = 0; i < 120; i++) {
  const id = crypto.randomUUID();
  const message = { type: 'user', uuid: id, session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: `Window row ${i} end` }] } };
  seed += `INSERT INTO sdk_messages(id,session_id,message_type,sdk_message,sdk_uuid,timestamp,send_status) VALUES(${quote(crypto.randomUUID())},${quote(sessionId)},'user',${quote(JSON.stringify(message))},${quote(id)},${quote(new Date(base + i * 1000).toISOString())},'consumed');`;
}
sql(seed);

const pairing = rpc('device.pair.create', { kind: 'human', name: 'Window browser' });
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const evidence = {};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await page.request.post(`${origin}/pair`, { headers: { origin }, data: { code: pairing.code, name: 'Window browser' } })).status(), 200);
  await page.goto(`${origin}/session/${sessionId}`);
  const row = (i) => page.getByText(`Window row ${i} end`, { exact: true });
  await row(119).first().waitFor({ timeout: 20000 });
  evidence.first = { newest: await row(119).count(), edge: await row(70).count(), beyond: await row(69).count() };
  assert.deepEqual(evidence.first, { newest: 1, edge: 1, beyond: 0 });
  const more = page.getByRole('button', { name: 'Load More Messages' });
  await more.click();
  await row(20).first().waitFor({ timeout: 10000 });
  evidence.second = { edge: await row(20).count(), beyond: await row(19).count() };
  assert.deepEqual(evidence.second, { edge: 1, beyond: 0 });
  await more.click();
  await row(0).first().waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);
  evidence.moreButtonAtStart = await more.count();
  assert.equal(evidence.moreButtonAtStart, 0);
  await page.screenshot({ path: `${run}/evidence/session-window.png` });
} finally {
  writeFileSync(`${run}/evidence/observed.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
console.log('PASS: a session opens on its last 50 messages and loads older ones 50 at a time');
