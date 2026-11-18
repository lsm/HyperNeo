import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-web-message-status.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
const rpc = (name, input = {}) => JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
  env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
})).reply;
const sql = (value) => execFileSync('sqlite3', [`${run}/data/daemon.db`, value], { encoding: 'utf8' });
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const opened = rpc('neo.open');
assert(opened.ok);
const sessionId = opened.sessionId;
const conversationId = sessionId.slice(4);
const states = ['failed'];
const ids = Object.fromEntries(states.map((state) => [state, crypto.randomUUID()]));
const now = Date.now();
let seed = '';
for (const [i, state] of states.entries()) {
  const id = ids[state];
  const content = [{ type: 'text', text: `SERVER ${state.toUpperCase()} synthetic input` }];
  const ask = { conversationId, requestId: id, askOrigin: { sessionId, messageId: id }, content };
  const at = new Date(now + i).toISOString();
  seed += `INSERT INTO neo_conversation_asks(conversation_id,request_id,payload_json,created_at) VALUES(${quote(conversationId)},${quote(id)},${quote(JSON.stringify(ask))},${quote(at)});`;
  if (state !== 'received') {
    const message = { type: 'user', uuid: id, session_id: sessionId, parent_tool_use_id: null, inputKind: 'human', message: { role: 'user', content } };
    const status = state === 'queued' ? 'enqueued' : state === 'failed' ? 'failed' : 'consumed';
    seed += `INSERT INTO sdk_messages(id,session_id,message_type,sdk_message,sdk_uuid,timestamp,send_status) VALUES(${quote(crypto.randomUUID())},${quote(sessionId)},'user',${quote(JSON.stringify(message))},${quote(id)},${quote(at)},${quote(status)});`;
  }
}
const publication = (id, replyTo) => {
  const payload = { conversationId, publicationId: id, shortText: 'Synthetic explicit reply.', fullText: 'Synthetic explicit reply.', links: [], replyTo };
  return `INSERT INTO neo_publications(conversation_id,publication_id,payload_json,created_at) VALUES(${quote(conversationId)},${quote(id)},${quote(JSON.stringify(payload))},${quote(new Date(now + 10).toISOString())});`;
};


sql(seed);
const askPage = rpc('neo.conversation.asks.read', { conversationId });
const conversation = rpc('neo.conversation.read', { conversationId });
const projected = (items) => Object.fromEntries(items.map((ask) => [ask.requestId, ask.messageStatus]));
const expected = Object.fromEntries(states.map((state) => [ids[state], state]));
assert.deepEqual(projected(askPage.items), expected);
assert.deepEqual(projected(conversation.items.filter((item) => item.role === 'human').map((item) => item.ask)), expected);
sql(`INSERT INTO neo_front_inputs(conversation_id,message_id,eligible,owner,failure_reason) VALUES(${quote(conversationId)},${quote(ids.failed)},1,'neo','Synthetic provider refusal');`);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const paired = rpc('device.pair.create', { kind: 'human', name: 'Synthetic viewer' });
assert(paired.ok);
const pairing = await browser.newContext();
const pairedResponse = await pairing.request.post(`http://127.0.0.1:${port}/pair`, { headers: { origin: `http://127.0.0.1:${port}` }, data: { code: paired.code, name: 'Synthetic viewer' } });
assert.equal(pairedResponse.status(), 200);
const storageState = await pairing.storageState();
await pairing.close();
const pages = [];
const observed = { passed: false };
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: theme, storageState });
    pages.push(page);
    await page.goto(`http://127.0.0.1:${port}/neo`);
    const failed = page.locator('article').filter({ hasText: 'SERVER FAILED synthetic input' });
    await failed.getByText('Synthetic provider refusal').waitFor();
    await failed.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await failed.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${run}/evidence/after-${theme}.png` });
  }
  const failed = pages[0].locator('article').filter({ hasText: 'SERVER FAILED synthetic input' });
  await failed.getByRole('button', { name: 'Retry', exact: true }).click();
  await failed.getByText('Retried').waitFor();
  assert.equal(await failed.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
  const result = rpc('neo.conversation.asks.read', { conversationId });
  assert.equal(result.items.length, 2);
  const original = result.items.find(item => item.requestId === ids.failed);
  const retry = result.items.find(item => item.retryOf === ids.failed);
  assert(retry && original.delivery.supersededBy === retry.requestId);
  assert.deepEqual(retry.content, original.content);
  await pages[0].reload();
  const reloaded = pages[0].locator('article').filter({ hasText: 'SERVER FAILED synthetic input' }).first();
  await reloaded.getByText('Retried').waitFor();
  assert.equal(await reloaded.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
  observed.passed = true;
  observed.retryAccepted = true;
  observed.originalRetriedAfterReload = true;
  writeFileSync(`${run}/evidence/neo-ui-retry.json`, JSON.stringify(observed, null, 2));
  console.log('PASS visible refusal, explicit retry and reload');
} finally { await browser.close(); }
