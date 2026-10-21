import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [port, run, phase] = process.argv.slice(2);
assert.notEqual(port, '8399'); assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home')); assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await writeFile(join(run, 'gitconfig'), '[user]\n name = Synthetic Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
async function git(cwd: string, ...args: string[]) {
 const child = Bun.spawn(['/usr/bin/git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
 const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
 assert.equal(code, 0, error); return text.trim();
}
const peer = join(run, 'peer'), remote = join(run, 'shared.git'), root = join(run, 'data', 'Neo');
await mkdir(peer); await git(peer, 'init', '--initial-branch=main', '--quiet');
for (const path of ['README.md', 'direction.md', 'notes.md']) await writeFile(join(peer, path), 'Initial\n');
await writeFile(join(peer, '.gitignore'), '.coordinators/\n'); await git(peer, 'add', '.'); await git(peer, 'commit', '-m', 'Initial');
await git(run, 'clone', '--bare', peer, remote); await git(peer, 'remote', 'add', 'origin', remote);
const local = 'Human local bytes  \n', other = 'Chosen remote bytes 🦊\n';
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${port}/ws`, autoReconnect: false });
hub.registerTransport(transport); await transport.initialize();
const rpc = (name: string, input: unknown) => hub.request<Record<string, unknown>>('operation.invoke', { name, input });
const db = new Database(join(run, 'data', 'daemon.db'), { readonly: true });
const evidence: Record<string, unknown> = { run, port, phase };
async function divergent(path: string) {
 await git(peer, 'pull', '--ff-only', 'origin', 'main');
 await writeFile(join(root, path), local); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Human local version');
 const localHead = await git(root, 'rev-parse', 'HEAD');
 await writeFile(join(peer, path), other); await git(peer, 'add', '.'); await git(peer, 'commit', '-m', 'Human remote version'); await git(peer, 'push', 'origin', 'main');
 const remoteHead = await git(peer, 'rev-parse', 'HEAD');
 const conflict = await rpc('neo.home.read', { path }); assert.equal(conflict.ok, false); assert(conflict.questionId);
 const question = db.prepare('SELECT * FROM neo_questions WHERE id=?').get(conflict.questionId) as Record<string, unknown>;
 const accepted = await rpc('neo.question.answer', { questionId: question.id, answer: ['Use remote'] }); assert.equal(accepted.ok, true);
 return { path, localHead, remoteHead, questionId: question.id, askId: question.ask_id };
}
try {
 await rpc('neo.open', {}); assert.equal((await rpc('neo.home.init', { remoteUrl: remote })).ok, true);
 const normal = await divergent('notes.md'); evidence.normal = normal;
 const input = { path: normal.path, content: other, message: 'Apply recorded choice', conflictQuestionId: normal.questionId };
 const first = await rpc('neo.home.save', input); evidence.normalResult = first;
 if (phase === 'before') {
  assert.equal(first.ok, false); assert(String(first.reason).includes('conflict'));
  assert.equal(await readFile(join(root, normal.path), 'utf8'), local);
  console.log('REPRODUCED: actual human choice is recorded but neo.home.save still refuses the conflict.');
 } else {
  assert.equal(first.ok, true); assert.equal(await readFile(join(root, normal.path), 'utf8'), other);
  await git(root, 'merge-base', '--is-ancestor', normal.localHead, 'HEAD'); await git(root, 'merge-base', '--is-ancestor', normal.remoteHead, 'HEAD');
  assert.equal(await git(remote, 'rev-parse', 'main'), first.commit);
  const protectedFile = await divergent('direction.md'); evidence.protected = protectedFile;
  const protectedInput = { path: protectedFile.path, content: other, message: 'Apply protected choice', conflictQuestionId: protectedFile.questionId };
  evidence.withoutConfirmation = await rpc('neo.home.save', protectedInput);
  assert(String((evidence.withoutConfirmation as { reason: string }).reason).includes('confirmation_required'));
  assert.equal(await readFile(join(root, 'direction.md'), 'utf8'), local);
  const confirm = { path: 'direction.md', sha256: createHash('sha256').update(other).digest('hex') };
  const asked = await rpc('neo.question.ask', { askId: protectedFile.askId, kind: 'yesno', text: `Save ${confirm.path}\nSHA-256: ${confirm.sha256}`, yesLabel: 'Save these exact bytes', noLabel: 'Keep current', confirm });
  const confirmationId = (asked.question as { id: string }).id;
  assert.equal((await rpc('neo.question.answer', { questionId: confirmationId, answer: 'yes' })).ok, true);
  evidence.confirmed = await rpc('neo.home.save', { ...protectedInput, questionId: confirmationId });
  assert.equal((evidence.confirmed as { ok: boolean }).ok, true);
  assert.equal(await readFile(join(root, 'direction.md'), 'utf8'), other);
  assert((await readFile(join(root, 'decisions.md'), 'utf8')).includes(confirmationId));
  assert((await git(root, 'log', '-1', '--format=%B')).includes(`Neo-Confirmed-By: question ${confirmationId}`));
  await git(root, 'merge-base', '--is-ancestor', protectedFile.localHead, 'HEAD'); await git(root, 'merge-base', '--is-ancestor', protectedFile.remoteHead, 'HEAD');
  assert.equal(await git(root, 'status', '--porcelain'), ''); evidence.finalHead = await git(root, 'rev-parse', 'HEAD');
  console.log('PASS: public RPC applies the normal choice, refuses protected choice alone, and applies it only after separate exact human yes; both histories survive.');
 }
} finally {
 await writeFile(join(run, 'evidence', 'neo-home-apply-choice.json'), JSON.stringify(evidence, null, 2));
 db.close(); await transport.close();
}
