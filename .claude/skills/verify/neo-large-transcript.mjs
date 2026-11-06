import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-large-transcript.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const rpcRaw = (name, input, wait = '0') => execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input), wait], {
  env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8', maxBuffer: 1 << 28,
});
const rpc = (name, input = {}) => JSON.parse(rpcRaw(name, input)).reply;
const sql = (value) => execFileSync('sqlite3', [`${run}/data/daemon.db`, value], { encoding: 'utf8' });
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

const opened = rpc('neo.open');
assert(opened.ok);
const { sessionId } = opened;
let seed = '';
for (let i = 0; i < 5; i++) {
  const id = crypto.randomUUID();
  const head = JSON.stringify({ type: 'user', uuid: id, session_id: sessionId, parent_tool_use_id: null, inputKind: 'human' }).slice(0, -1);
  const body = `${head},"message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"`;
  seed += `INSERT INTO sdk_messages(id,session_id,message_type,sdk_message,sdk_uuid,timestamp,send_status) VALUES(${quote(crypto.randomUUID())},${quote(sessionId)},'user',${quote(body)} || replace(hex(zeroblob(4500000)),'00','AA') || '"}}]}}',${quote(id)},${quote(new Date(Date.now() + i).toISOString())},'consumed');`;
}
sql(seed);
const stored = Number(sql(`SELECT sum(length(sdk_message)) FROM sdk_messages WHERE session_id=${quote(sessionId)}`));
assert(stored > 40 * 1024 * 1024, 'stored rows must exceed the outbound limit');
const raw = rpcRaw('rpc:liveQuery.subscribe', { queryName: 'messages.bySession', params: [sessionId, 200], subscriptionId: 'verify-too-large' }, '4');
const rawTooLarge = raw.includes('MESSAGE_TOO_LARGE');
assert(!rawTooLarge, 'large images must stay out of the raw transcript window');

const pairing = rpc('device.pair.create', { kind: 'human', name: 'Large transcript browser' });
assert.equal(pairing.approval, 'approved');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const text = 'Large transcript composer check';
const evidence = { stored, rawTooLarge, composer: false, sent: false, visible: false };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await page.request.post(`${origin}/pair`, { headers: { origin }, data: { code: pairing.code, name: 'Large transcript browser' } })).status(), 200);
  await page.goto(`${origin}/neo`);
  const composer = page.getByRole('textbox', { name: 'Message Neo' });
  evidence.composer = await composer.waitFor({ timeout: 20000 }).then(() => true, () => false);
  await page.screenshot({ path: `${run}/evidence/neo-page.png` });
  assert(evidence.composer, 'the Neo composer must render');
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByText(text).first().waitFor({ timeout: 20000 });
  evidence.visible = true;
  for (let i = 0; i < 40 && !evidence.sent; i++) {
    evidence.sent = sql(`SELECT count(*) FROM neo_conversation_asks WHERE payload_json LIKE ${quote(`%${text}%`)}`).trim() === '1';
    if (!evidence.sent) await page.waitForTimeout(250);
  }
  assert(evidence.sent, 'the message must reach the daemon');
  await page.waitForTimeout(3000);
  evidence.stillVisible = await page.getByText(text).first().isVisible().catch(() => false);
  evidence.afterSendBody = (await page.innerText('body')).slice(0, 500);
  await page.screenshot({ path: `${run}/evidence/neo-sent.png` });
  await page.reload();
  await page.getByRole('textbox', { name: 'Message Neo' }).waitFor({ timeout: 20000 });
  evidence.visibleAfterReload = await page.getByText(text).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
  await page.screenshot({ path: `${run}/evidence/neo-reloaded.png` });
  assert(evidence.stillVisible && evidence.visibleAfterReload, 'the sent message must stay on the page');
} finally {
  writeFileSync(`${run}/evidence/observed.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
console.log('PASS: a transcript over the size limit still shows the Neo composer and sends');
