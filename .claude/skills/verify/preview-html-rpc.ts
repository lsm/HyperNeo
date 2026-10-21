import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [directory, phase, port = '9386'] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
assert.notEqual(port, '8399');
const hostile = `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><meta http-equiv="Content-Security-Policy" content="script-src *"><base href="https://evil.example/"><title>Hostile 🦊</title><style>@import url(https://evil.example/a.css);h1{color:#123}</style><script>parent.postMessage(document.cookie,'*')</script></head><body onload="x()"><h1>Sentinel heading</h1><p style="background:url(//evil.example/x)">Body text</p><img src="https://evil.example/p.png"><form action="https://evil.example"><input name="t"></form><iframe src="https://evil.example"></iframe><svg onload="x()"><script>x()</script></svg><a href="javascript:x()">bad</a> <a href="https://github.com/lsm/HyperNeo">repo</a></body></html>`;
if (phase === 'seed') {
 const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-reads-rpc.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
 const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0, output);
 writeFileSync(join(root, 'workspace', 'hostile.html'), hostile);
 console.log('seeded isolated hostile HTML fixture');
} else {
 const rpc = async (name: string, input: unknown) => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./rpc.ts', import.meta.url)), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text()); assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result)); return result.reply.value ?? result.reply;
 };
 const evidencePath = join(root, 'evidence', 'html-rpc.json');
 const register = (path: string) => rpc('artifact.file.register', { requestId: path, context: { kind: 'todo', id: 'todo' }, path, title: path });
 const ref = phase === 'capture' ? (await register('hostile.html')).artifact : JSON.parse(readFileSync(evidencePath, 'utf8')).ref;
 const page = await rpc('artifact.file.html', { artifactId: ref.artifactId });
 assert.equal(page.accepted, true, JSON.stringify(page));
 const lower = page.document.toLowerCase();
 assert(page.document.startsWith('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#x27;none&#x27;; script-src &#x27;none&#x27;'));
 for (const banned of ['<script', 'onload', 'javascript:', 'evil.example', '<iframe', '<form', '<input', '<svg', '<base', 'refresh', '@import', 'script-src *', 'postmessage'])
  assert(!lower.includes(banned), `prepared document still contains ${banned}`);
 for (const kept of ['<title>Hostile 🦊</title>', '<h1>Sentinel heading</h1>', 'Body text', 'color:#123']) assert(page.document.includes(kept), kept);
 assert.equal(page.scriptsRemoved, true);
 assert.deepEqual(page.links, [{ text: 'repo', href: 'https://github.com/lsm/HyperNeo' }]);
 if (phase === 'capture') {
  const markdown = await register('report.md'); assert(markdown.accepted);
  assert.deepEqual(await rpc('artifact.file.html', { artifactId: markdown.artifact.artifactId }), { accepted: false, reason: 'unsupported_type' });
  assert.deepEqual(await rpc('artifact.file.html', { artifactId: 'missing' }), { accepted: false, reason: 'unavailable' });
  writeFileSync(evidencePath, JSON.stringify({ ref, page }, null, 2));
 } else {
  assert.equal(phase, 'restart');
  assert.deepEqual(page, JSON.parse(readFileSync(evidencePath, 'utf8')).page);
  writeFileSync(join(root, 'evidence', 'html-rpc-restart.json'), JSON.stringify({ ref, page }, null, 2));
 }
 console.log(`PASS: ${phase} hostile HTML served only as the inert CSP-first preview document`);
}
