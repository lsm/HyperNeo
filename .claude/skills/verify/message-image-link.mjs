import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: message-image-link.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const env = { ...process.env, VERIFY_PORT: port };
const rpc = (name, input = {}) =>
  JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env, encoding: 'utf8', maxBuffer: 1 << 28 })).reply;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function noisePng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

const opened = rpc('neo.open');
assert(opened.ok);
const { sessionId } = opened;
const png = noisePng(1600, 1400);
const data = png.toString('base64');
const uuids = Array.from({ length: 5 }, () => crypto.randomUUID());
writeFileSync(`${run}/seed.sql`, uuids.map((uuid, index) => {
  const message = { type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null, inputKind: 'human', message: { role: 'user', content: [{ type: 'text', text: `Synthetic photo ${index}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] } };
  return `INSERT INTO sdk_messages(id,session_id,message_type,sdk_message,sdk_uuid,timestamp,send_status) VALUES(${quote(crypto.randomUUID())},${quote(sessionId)},'user',${quote(JSON.stringify(message))},${quote(uuid)},datetime('now'),'consumed');\n`;
}).join(''));
execFileSync('sqlite3', [`${run}/data/daemon.db`, `.read ${run}/seed.sql`]);

const origin = `http://127.0.0.1:${port}`;
const timing = JSON.parse(execFileSync('bun', ['.claude/skills/verify/message-window-time.ts', sessionId, '50'], { env, encoding: 'utf8' }));
const evidence = { imageBytes: png.length, storedChars: data.length * 5, timing };
for (const reads of [timing.window, timing.page])
  for (const read of reads) {
    assert.equal(read.rows, 5);
    assert(read.bytes < 16 * 1024, `a window must stay small: ${read.bytes}`);
  }

const path = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${uuids[0]}/images/1`;
const agent = execFileSync('cat', [`${run}/data/agent-read.credential`], { encoding: 'utf8' });
const agentCredential = JSON.parse(agent).credential;
evidence.unpaired = (await fetch(`${origin}${path}`)).status;
evidence.agent = (await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${agentCredential}` } })).status;
assert.equal(evidence.unpaired, 401);
assert.equal(evidence.agent, 401);

const pairing = rpc('device.pair.create', { kind: 'human', name: 'Image link browser' });
assert.equal(pairing.approval, 'approved');
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.VERIFY_BROWSER ? { executablePath: process.env.VERIFY_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  assert.equal((await page.request.post(`${origin}/pair`, { headers: { origin }, data: { code: pairing.code, name: 'Image link browser' } })).status(), 200);
  const paired = await page.request.get(`${origin}${path}`);
  evidence.paired = { status: paired.status(), type: paired.headers()['content-type'], same: Buffer.from(await paired.body()).equals(png) };
  assert.deepEqual(evidence.paired, { status: 200, type: 'image/png', same: true });
  const fetched = [];
  page.on('response', (response) => { if (response.url().includes('/images/')) fetched.push({ url: new URL(response.url()).pathname, status: response.status() }); });
  await page.goto(`${origin}/session/${sessionId}`);
  await page.getByText('Synthetic photo 0').waitFor({ timeout: 30000 });
  const opener = page.getByRole('button', { name: 'Open attached image' }).first();
  await opener.waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${run}/evidence/session-placeholders.png` });
  evidence.fetchedBeforeOpen = fetched.length;
  assert.equal(fetched.length, 0, 'nothing loads the full image before it is opened');
  await opener.click();
  const full = page.getByTestId('attachment-lightbox').locator('img');
  await full.waitFor({ timeout: 10000 });
  await page.waitForFunction((image) => image.complete && image.naturalWidth > 0, await full.elementHandle(), { timeout: 20000 });
  evidence.opened = await full.evaluate((image) => ({ src: new URL(image.src).pathname, width: image.naturalWidth, height: image.naturalHeight }));
  evidence.fetched = fetched;
  await page.screenshot({ path: `${run}/evidence/session-full-image.png` });
  assert.deepEqual([evidence.opened.width, evidence.opened.height], [1600, 1400]);
  assert.equal(fetched.filter(({ status }) => status === 200).length, 1);
} finally {
  writeFileSync(`${run}/evidence/message-image-link.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
console.log('PASS: five large images stay out of the window and open from a paired-only link');
