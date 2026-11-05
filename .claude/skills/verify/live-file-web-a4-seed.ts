import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';

const [directory, phase, rootSession, artifact] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
const workspace = join(root, 'workspace');
if (phase === 'counts') {
  const db = new Database(join(root, 'data/daemon.db'), {readonly: true});
  try { console.log(JSON.stringify(['artifact_files', 'artifact_file_identity'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()))); }
  finally { db.close(); }
} else if (phase === 'seed') {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-taps-seed.ts', import.meta.url)), root, 'seed'], {env: process.env, stdout: 'pipe', stderr: 'inherit'});
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0, output);
  const crc = (bytes: Buffer) => { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, bytes: Buffer) => { const data = Buffer.concat([Buffer.from(type), bytes]); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(data)); return Buffer.concat([length, data, checksum]); };
  const png = (blue: boolean) => {
    const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(160, 4); header[8] = 8; header[9] = 2;
    const pixels = Buffer.alloc(160 * (1 + 256 * 3));
    for (let y = 0; y < 160; y++) for (let x = 0; x < 256; x++) { const i = y * 769 + 1 + x * 3; pixels[i] = blue ? 30 : 180; pixels[i + 1] = 80 + Math.floor(y / 2); pixels[i + 2] = blue ? 210 : 30; }
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  };
  const files = ['current notes.md', 'current.html', 'current.png', 'plain.txt', 'unknown.pdf'].map(name => join(workspace, name));
  writeFileSync(files[0], '# Live A\n\nCurrent **Markdown** 中文.\n');
  writeFileSync(files[1], '<h1>Live HTML A</h1><p style="padding:24px;background:#d7eefa">Safe current HTML</p><script>window.unsafe=1</script><img src="https://example.invalid/remote.png"><a href="https://example.com/details">Details</a>');
  writeFileSync(files[2], png(true));
  writeFileSync(join(root, 'image-a.png'), png(true));
  writeFileSync(join(root, 'image-b.png'), png(false));
  writeFileSync(files[3], 'Plain current A\n' + 'bounded bytes 中文\n'.repeat(20000));
  writeFileSync(files[4], '%PDF-synthetic');
  writeFileSync(join(root, 'live-web-fixture.json'), JSON.stringify({files}));
  console.log('seeded live browser files');
} else {
  assert.equal(phase, 'publish');
  assert(rootSession?.startsWith('neo:'));
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-taps-seed.ts', import.meta.url)), root, 'publish', rootSession, artifact], {env: process.env, stdout: 'pipe', stderr: 'inherit'});
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0, output);
  const {files} = JSON.parse(readFileSync(join(root, 'live-web-fixture.json'), 'utf8'));
  const text = 'Live source-bound files: ' + files.map((file: string) => `\`${file}\``).join(', ') + '.';
  const db = new Database(join(root, 'data/daemon.db'));
  const publicationId = crypto.randomUUID();
  try { assert(new NeoPublicationRepository(db).append({conversationId: rootSession.slice(4), publicationId, producerInput: {sessionId: rootSession, messageId: 'synthetic-live-turn'}, shortText: text, fullText: text, links: []}).accepted); }
  finally { db.close(); }
  mkdirSync(join(root, 'evidence'), {recursive: true});
  writeFileSync(join(root, 'evidence/live-publication.json'), JSON.stringify({publicationId, files}));
  console.log(JSON.stringify({publicationId}));
}
