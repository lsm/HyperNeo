import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [port, run, phase] = process.argv.slice(2);
assert.notEqual(port, '8399');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await writeFile(join(run, 'gitconfig'), '[user]\n name = Synthetic Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
async function git(cwd: string, ...args: string[]) {
 const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
 const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
 assert.equal(code, 0, error); return text.trim();
}
const peer = join(run, 'peer'), remote = join(run, 'shared.git'), root = join(run, 'data', 'Neo');
await mkdir(peer); await git(peer, 'init', '--initial-branch=main', '--quiet');
await writeFile(join(peer, 'direction.md'), 'Initial\n');
await writeFile(join(peer, '.gitignore'), '.coordinators/\n');
await git(peer, 'add', '.'); await git(peer, 'commit', '-m', 'Initial');
await git(run, 'clone', '--bare', peer, remote); await git(peer, 'remote', 'add', 'origin', remote);
const local = `Human local choice\n${'Human full line with trailing spaces  \n'.repeat(90)}<script>not executable</script>\n`;
const other = `Other machine choice\n${'Remote full line\n'.repeat(90)}`;
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${port}/ws`, autoReconnect: false });
hub.registerTransport(transport); await transport.initialize();
const rpc = (name: string, input: unknown) => hub.request<Record<string, unknown>>('operation.invoke', { name, input });
const db = new Database(join(run, 'data', 'daemon.db'), { readonly: true });
const evidence: Record<string, unknown> = { port, run, phase };
try {
 evidence.open = await rpc('neo.open', {});
 assert.equal((await rpc('neo.home.init', { remoteUrl: remote })).ok, true);
 await writeFile(join(root, 'direction.md'), local); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Human local choice');
 const localHead = await git(root, 'rev-parse', 'HEAD');
 await writeFile(join(peer, 'direction.md'), other); await git(peer, 'add', '.'); await git(peer, 'commit', '-m', 'Other machine choice'); await git(peer, 'push', 'origin', 'main');
 const remoteHead = await git(peer, 'rev-parse', 'HEAD');
 evidence.first = await rpc('neo.home.read', { path: 'direction.md' });
 evidence.second = await rpc('neo.home.save', { path: 'notes.md', content: 'Must not be written', message: 'Synthetic save' });
 const questions = db.prepare('SELECT * FROM neo_questions').all() as Record<string, unknown>[];
 evidence.questions = questions; evidence.localHead = localHead; evidence.remoteHead = remoteHead;
 evidence.localPreserved = await readFile(join(root, 'direction.md'), 'utf8') === local;
 evidence.headPreserved = await git(root, 'rev-parse', 'HEAD') === localHead;
 evidence.status = await git(root, 'status', '--porcelain');
 assert.equal(evidence.localPreserved, true); assert.equal(evidence.headPreserved, true); assert.equal(evidence.status, '');
 if (phase === 'before') { assert.equal(questions.length, 0); console.log('REPRODUCED: real RPC refuses a conflict but creates no human question.'); }
 else {
  assert.equal(questions.length, 1);
  const q = questions[0]; assert.equal(q.state, 'open'); assert(String(q.text).length < 1800);
  assert(String(q.text).includes('direction.md')); assert(String(q.text).includes('not apply'));
  assert(String(q.document).includes(local)); assert(String(q.document).includes(other));
  assert(String(q.document).includes(localHead)); assert(String(q.document).includes(remoteHead));
  evidence.question = await rpc('neo.question.get', { questionId: q.id });
  assert.equal((evidence.question as { question: { document: string } }).question.document, q.document);
  evidence.askId = q.ask_id; evidence.questionId = q.id;
  console.log('PASS: one compact question, both full immutable versions, unchanged local/remote history.');
 }
} finally {
 await writeFile(join(run, 'evidence', 'neo-home-conflicts.json'), JSON.stringify(evidence, null, 2));
 db.close(); await transport.close();
}
