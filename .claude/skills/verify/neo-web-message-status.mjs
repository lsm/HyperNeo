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
const states = ['read', 'queued', 'working', 'answered', 'received', 'failed'];
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
seed += publication(crypto.randomUUID(), [ids.answered]);
seed += `UPDATE sessions SET processing_state=${quote(JSON.stringify({ status: 'processing', phase: 'thinking', messageId: ids.working }))} WHERE id=${quote(sessionId)};`;
sql(seed);
const askPage = rpc('neo.conversation.asks.read', { conversationId });
const conversation = rpc('neo.conversation.read', { conversationId });
const projected = (items) => Object.fromEntries(items.map((ask) => [ask.requestId, ask.messageStatus]));
const expected = Object.fromEntries(states.map((state) => [ids[state], state]));
assert.deepEqual(projected(askPage.items), expected);
assert.deepEqual(projected(conversation.items.filter((item) => item.role === 'human').map((item) => item.ask)), expected);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
const pages = [];
const observed = { askPage, conversation, widths: [], inputsBefore: states.length };
const save = () => writeFileSync(`${run}/evidence/neo-web-message-status.json`, JSON.stringify(observed, null, 2));
const article = (page, state) => page.locator('article').filter({ hasText: `SERVER ${state.toUpperCase()} synthetic input` });
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    pages.push({ page, width });
    await page.goto(`http://127.0.0.1:${port}/neo`);
    await article(page, 'read').waitFor();
    const shown = {};
    for (const state of states) shown[state] = await article(page, state).locator('[data-message-status]').textContent();
    observed.widths.push({ width, initialLabels: shown });
    await article(page, 'read').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${run}/evidence/status-initial-${width}.png`, fullPage: true });
    save();
    for (const state of states) assert.equal(shown[state], state[0].toUpperCase() + state.slice(1));
    assert.equal(await article(page, 'read').locator('[data-message-status]').getAttribute('title'), 'Neo read this message but has not answered it.');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  sql(`UPDATE sdk_messages SET send_status='consumed' WHERE session_id=${quote(sessionId)} AND sdk_uuid=${quote(ids.queued)};`);
  assert(rpc('neo.session.mute', { key: 'synthetic-status-refresh', muted: true }).ok);
  for (const { page, width } of pages) {
    await article(page, 'queued').locator('[data-message-status="read"]').waitFor();
    observed.widths.find((row) => row.width === width).afterConsumption = 'Read';
    await article(page, 'queued').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${run}/evidence/status-read-${width}.png`, fullPage: true });
  }
  sql(publication(crypto.randomUUID(), [ids.queued]));
  assert(rpc('neo.session.mute', { key: 'synthetic-status-refresh', muted: false }).ok);
  for (const { page, width } of pages) {
    await article(page, 'queued').locator('[data-message-status="answered"]').waitFor();
    observed.widths.find((row) => row.width === width).afterReply = 'Answered';
    await article(page, 'queued').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${run}/evidence/status-answered-${width}.png`, fullPage: true });
  }
  observed.inputsAfter = rpc('neo.conversation.asks.read', { conversationId }).items.length;
  assert.equal(observed.inputsAfter, observed.inputsBefore);
  observed.passed = true;
  save();
  console.log(JSON.stringify(observed.widths, null, 2));
} finally {
  save();
  await browser.close();
}
