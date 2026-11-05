import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink, truncate } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import fixtures from './fixtures/live-media-a3.json';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = process.argv[2];
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
if (process.argv[3] === 'version') {
  const { Database } = await import('../../../packages/daemon/src/storage/sqlite-compat.ts');
  const { createLiveFileRead } = await import('../../../packages/daemon/src/lib/artifacts/live-file-read.ts');
  const db = new Database(join(run, 'data/daemon.db'), { readonly: true });
  try {
    const op = createLiveFileRead(() => db, process.env.HOME);
    const result = await op.execute(op.inputSchema.parse({ sourceMessageOrCard: { kind: 'message', id: process.argv[4] }, reference: 'pixel.gif' }), { source: 'rpc', principal: 'local' });
    console.log(JSON.stringify(result));
  } finally { db.close(); }
  process.exit(0);
}
await mkdir(join(run, 'evidence'), { recursive: true });
const workspace = join(run, 'workspace');
await mkdir(workspace);
await writeFile(join(run, 'bin/gh'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
const png = Buffer.from(fixtures.png, 'base64');
const gif = Buffer.from(fixtures.gif, 'base64');
const jpg = Buffer.from(fixtures.jpg, 'base64');
const webp = Buffer.from(fixtures.webp, 'base64');
const bomb = Buffer.from(png);
bomb.writeUInt32BE(100000, 16);
bomb.writeUInt32BE(100000, 20);
let requests = 0;
const remote = createServer((_req, res) => { requests++; res.end('REMOTE_SENTINEL'); });
await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
const port = (remote.address() as { port: number }).port;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
const evidence: Record<string, unknown> = {};
try {
const hostile = `<h1>Report A</h1><script>window.bad=1</script><img onerror="bad()" src="http://127.0.0.1:${port}/remote.png"><link rel="stylesheet" href="local.css"><img src="local.png"><iframe src="http://127.0.0.1:${port}"></iframe><style>.bad{background:url(http://127.0.0.1:${port}/x)}</style><img alt="safe" src="data:image/png;base64,${png.toString('base64')}"><img alt="bomb" src="data:image/png;base64,${bomb.toString('base64')}"><p style="background:url(data:image/png;base64,${bomb.toString('base64')})">No bomb</p><a href="https://example.com/report">Link</a>`;
for (const [name, data] of Object.entries({ 'report.html': hostile, 'pixel.png': png, 'pixel.gif': gif, 'pixel.jpg': jpg, 'pixel.webp': webp, 'empty.png': Buffer.alloc(0), 'long.html': '<pre>' + '🦊 paragraph\n'.repeat(40000) + '</pre><script>bad()</script>', 'bomb.png': bomb, 'fake.png': Buffer.from('<svg onload="bad()"/>'), 'wrong.jpg': png, 'short.png': png.subarray(0, 20), 'unknown.svg': '<svg/>', 'local.css': 'LOCAL_SENTINEL', 'local.png': png, 'expanded.html': '&'.repeat(550000), 'invalid.html': Buffer.from([255]) })) await writeFile(join(workspace, name), data);
await writeFile(join(workspace, 'large.png'), png);
await truncate(join(workspace, 'large.png'), 32 * 1024 * 1024 + 1);
const chunk = (name: string, data: Buffer) => {
  const type = Buffer.from(name);
  let crc = 0xffffffff;
  for (const b of Buffer.concat([type, data])) { crc ^= b; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, type, data, checksum]);
};
const largeValid = Buffer.concat([png.subarray(0, -12), chunk('tEXt', Buffer.from('Comment\0' + 'x'.repeat(2200000))), png.subarray(-12)]);
await writeFile(join(workspace, 'chunked.png'), largeValid);
app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: run }), disableWorktrees: true }, standalone: false, verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  await app.db.createSession({ id: 'worker', title: 'Synthetic', workspacePath: workspace, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: {}, metadata: {} } as never);
  const db = app.db.getDatabase();
  const uuid = crypto.randomUUID();
  const paths = ['report.html', 'pixel.png', 'pixel.gif', 'pixel.jpg', 'pixel.webp', 'empty.png', 'long.html', 'bomb.png', 'fake.png', 'wrong.jpg', 'short.png', 'large.png', 'chunked.png', 'unknown.svg', 'expanded.html', 'invalid.html'];
  app.db.getSDKMessageRepo().saveSDKMessage('worker', { type: 'assistant', uuid, session_id: 'worker', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: paths.map(p => `\`${p}\``).join('\n') }] } } as never);
  const source = db.prepare('SELECT id FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?').get('worker', uuid) as { id: string };
  await waitForSdkBodyCopy(db);
  const counts = () => [db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get(), db.prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()];
  const before = counts();
  ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise((resolve, reject) => { ws!.onopen = resolve; ws!.onerror = reject; });
  type Result = { accepted: boolean; reason?: string; kind?: string; data?: string; version?: string; nextOffset?: number; complete?: boolean; mediaType?: string; width?: number; height?: number; scriptsRemoved?: boolean; links?: { href: string }[] };
  const tap = (reference: string, extra = {}) => new Promise<Result>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => reject(new Error('RPC timeout')), 10000);
    ws!.onmessage = e => { const r = JSON.parse(String(e.data)); if ((r.requestId ?? r.id) !== id) return; clearTimeout(timeout); r.error ? reject(new Error(JSON.stringify(r.error))) : resolve(r.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'file.reference.read', input: { sourceMessageOrCard: { kind: 'message', id: source.id }, reference, ...extra } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const html = await tap('report.html');
  assert.equal(html.accepted, true, 'Live HTML must return an inert current document');
  assert.equal(html.kind, 'html');
  const document = Buffer.from(html.data!, 'base64').toString();
  assert(document.includes('Report A'));
  assert(document.includes('Content-Security-Policy'));
  for (const value of ['<script', 'onerror', '<iframe', '127.0.0.1', 'local.css', 'local.png', 'LOCAL_SENTINEL', bomb.toString('base64')]) assert(!document.includes(value), value);
  assert(document.includes(png.toString('base64')));
  assert.equal(html.scriptsRemoved, true);
  assert.equal(html.links![0].href, 'https://example.com/report');
  await writeFile(join(workspace, 'report.html'), '<h1>Report B</h1>');
  assert.equal((await tap('report.html', { version: html.version })).reason, 'file_changed');
  assert(Buffer.from((await tap('report.html')).data!, 'base64').toString().includes('Report B'));
  await unlink(join(workspace, 'report.html'));
  assert.equal((await tap('report.html')).reason, 'missing');
  for (const [path, bytes, mime] of [['pixel.png', png, 'image/png'], ['pixel.gif', gif, 'image/gif'], ['pixel.jpg', jpg, 'image/jpeg'], ['pixel.webp', webp, 'image/webp']] as const) {
    const result = await tap(path);
    assert.equal(result.accepted, true);
    assert.equal(result.kind, 'image');
    assert.equal(result.mediaType, mime);
    assert.equal(result.width, 1); assert.equal(result.height, 1);
    assert.deepEqual(Buffer.from(result.data!, 'base64'), bytes);
  }
  const currentVersion = (await tap('pixel.gif')).version;
  const restarted = spawnSync(process.execPath, [fileURLToPath(import.meta.url), run, 'version', source.id], { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(restarted.status, 0, restarted.stderr);
  const restartedRead = JSON.parse(restarted.stdout.trim().split('\n').at(-1)!);
  assert.equal(restartedRead.accepted, true);
  assert.notEqual(currentVersion, restartedRead.version);
  assert.equal(Buffer.from(restartedRead.data, 'base64').toString('base64'), gif.toString('base64'));
  evidence.processVersionsIsolated = true;
  const collected: Buffer[] = [];
  let offset = 0; let version: string | undefined;
  for (;;) {
    const part = await tap('chunked.png', { offset, ...(version ? { version } : {}) });
    assert.equal(part.accepted, true);
    collected.push(Buffer.from(part.data!, 'base64'));
    assert(collected.at(-1)!.length <= 262144);
    offset = part.nextOffset!; version ??= part.version;
    if (part.complete) break;
  }
  assert.deepEqual(Buffer.concat(collected), largeValid);
  const htmlParts: Buffer[] = [];
  let htmlOffset = 0; let htmlVersion: string | undefined;
  for (;;) {
    const part = await tap('long.html', { offset: htmlOffset, ...(htmlVersion ? { version: htmlVersion } : {}) });
    assert.equal(part.accepted, true);
    assert.equal(part.kind, 'html');
    htmlParts.push(Buffer.from(part.data!, 'base64'));
    assert(htmlParts.at(-1)!.length <= 262144);
    htmlVersion ??= part.version;
    assert.equal(part.version, htmlVersion);
    htmlOffset = part.nextOffset!;
    if (part.complete) break;
  }
  const longDocument = Buffer.concat(htmlParts).toString();
  assert(longDocument.includes('🦊 paragraph'));
  assert(!longDocument.includes('<script'));
  evidence.htmlChunks = htmlParts.length;
  const imageA = await tap('pixel.png');
  await writeFile(join(workspace, 'pixel.png'), largeValid);
  assert.equal((await tap('pixel.png', { version: imageA.version })).reason, 'file_changed');
  await unlink(join(workspace, 'pixel.png'));
  assert.equal((await tap('pixel.png')).reason, 'missing');
  for (const [path, reason] of [['empty.png', 'unsupported_type'], ['bomb.png', 'size_limit'], ['large.png', 'size_limit'], ['expanded.html', 'size_limit'], ['fake.png', 'unsupported_type'], ['wrong.jpg', 'unsupported_type'], ['short.png', 'unsupported_type'], ['unknown.svg', 'unsupported_type'], ['invalid.html', 'unsupported_type']]) assert.equal((await tap(path)).reason, reason, path);
  assert.equal(requests, 0);
  assert.deepEqual(counts(), before);
  assert.equal(existsSync(join(run, 'data/artifacts')), false);
  evidence.htmlSanitized = true; evidence.currentHtmlEditDelete = true; evidence.imageEditDelete = true;
  evidence.imageChunks = collected.length; evidence.imageBytes = largeValid.length;
  evidence.inlineImagesBounded = true; evidence.remoteRequests = requests; evidence.noRowsOrBlobs = true; evidence.passed = true;
} finally {
  ws?.close(); await app?.cleanup();
  await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve()));
  evidence.resourcesClosed = true;
  await writeFile(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence));
