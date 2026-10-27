import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const [port, run, phase, mode] = process.argv.slice(2);
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
 const accepted = mode === 'chat'
  ? await rpc('neo.message.send', { sessionId: (await rpc('neo.snapshot', {})).sessionId, requestId: crypto.randomUUID(), content: 'Use remote', replyTo: { kind: 'question', id: question.id } })
  : await rpc('neo.question.answer', { questionId: question.id, answer: ['Use remote'] });
 assert.equal(accepted.ok, true);
 if (mode === 'chat') {
  const read = await rpc('neo.question.get', { questionId: question.id });
  assert.equal(read.answeredByHuman, true);
  evidence.chatAnswer = read;
 }
 return { path, localHead, remoteHead, questionId: question.id, askId: question.ask_id };
}
try {
 await rpc('neo.open', {}); assert.equal((await rpc('neo.home.init', { remoteUrl: remote })).ok, true);
 if (mode === 'ignored') {
  await writeFile(join(root, '.git', 'info', 'exclude'), 'private-note.txt\n');
  await writeFile(join(root, 'private-note.txt'), 'Human private bytes\n');
  await writeFile(join(peer, 'private-note.txt'), 'Remote independent bytes\n');
  await git(peer, 'add', '.'); await git(peer, 'commit', '-m', 'Remote independent document');
 }
 const normal = await divergent('notes.md'); evidence.normal = normal;
 if (mode === 'ignored') {
  evidence.privateAfterConflictRead = await readFile(join(root, 'private-note.txt'), 'utf8').catch(() => null);
  if (phase === 'after') assert.equal(evidence.privateAfterConflictRead, 'Human private bytes\n');
  await writeFile(join(root, 'private-note.txt'), 'Human private bytes\n');
 }
 const input = { path: normal.path, content: other, message: 'Apply recorded choice', conflictQuestionId: normal.questionId };
 if (mode === 'chat' && phase === 'before') {
  evidence.chatResult = await rpc('neo.home.save', input);
  assert.equal((evidence.chatResult as { ok: boolean }).ok, false);
  assert(String((evidence.chatResult as { reason: string }).reason).includes('human_choice_required'));
  console.log('REPRODUCED: human chat choice was recorded but save rejected the scalar answer.');
  process.exitCode = 0;
 } else {
 if (mode === 'chat' && phase === 'after') {
  const asked = await rpc('neo.question.ask', { askId: normal.askId, kind: 'choice', text: 'Which version?', options: ['Keep local', 'Use remote'], multiple: false });
  const questionId = (asked.question as { id: string }).id;
  assert.equal((await rpc('neo.question.answer', { questionId, answer: ['Use remote'] })).ok, true);
  evidence.unrelatedQuestion = await rpc('neo.home.save', { ...input, conflictQuestionId: questionId });
  assert.equal((evidence.unrelatedQuestion as { ok: boolean }).ok, false);
  assert(String((evidence.unrelatedQuestion as { reason: string }).reason).includes('question does not bind'));
  assert.equal(await git(root, 'rev-parse', 'HEAD'), normal.localHead);
  assert.equal(await git(remote, 'rev-parse', 'main'), normal.remoteHead);
  await writeFile(join(root, normal.path), 'Later local bytes\n');
  await git(root, 'add', normal.path); await git(root, 'commit', '-m', 'Later local version');
  await writeFile(join(peer, normal.path), 'Later remote bytes\n');
  await git(peer, 'add', normal.path); await git(peer, 'commit', '-m', 'Later remote version');
  await git(peer, 'push', 'origin', 'main');
  const changedLocal = await git(root, 'rev-parse', 'HEAD'), changedRemote = await git(remote, 'rev-parse', 'main');
  evidence.changedVersions = { changedLocal, changedRemote };
  evidence.unseenVersion = await rpc('neo.home.save', { ...input, content: 'Later remote bytes\n' });
  assert.equal((evidence.unseenVersion as { ok: boolean }).ok, false);
  assert.equal(await git(root, 'rev-parse', 'HEAD'), changedLocal);
  assert.equal(await git(remote, 'rev-parse', 'main'), changedRemote);
 }
 const first = await rpc('neo.home.save', input); evidence.normalResult = first;
 if (mode === 'ignored') {
  evidence.privateBytes = await readFile(join(root, 'private-note.txt'), 'utf8');
  assert.equal(first.ok, phase === 'before');
  assert.equal(evidence.privateBytes, phase === 'before' ? 'Remote independent bytes\n' : 'Human private bytes\n');
  if (phase === 'after') {
   assert.equal(await git(root, 'rev-parse', 'HEAD'), normal.localHead);
   assert.equal(await git(remote, 'rev-parse', 'main'), normal.remoteHead);
  }
  console.log(phase === 'before' ? 'REPRODUCED: merge replaced the ignored human file with remote bytes.' : 'PASS: merge refuses an ignored human-file collision without applying the choice.');
 } else if (phase === 'before') {
  assert.equal(first.ok, false); assert(String(first.reason).includes('conflict'));
  assert.equal(await readFile(join(root, normal.path), 'utf8'), local);
  console.log('REPRODUCED: actual human choice is recorded but neo.home.save still refuses the conflict.');
 } else {
  assert.equal(first.ok, true); assert.equal(await readFile(join(root, normal.path), 'utf8'), other);
  await git(root, 'merge-base', '--is-ancestor', normal.localHead, 'HEAD'); await git(root, 'merge-base', '--is-ancestor', normal.remoteHead, 'HEAD');
  assert.equal(await git(remote, 'rev-parse', 'main'), first.commit);
  if (mode === 'chat') {
   const changed = evidence.changedVersions as { changedLocal: string; changedRemote: string };
   await git(root, 'merge-base', '--is-ancestor', changed.changedLocal, 'HEAD');
   await git(root, 'merge-base', '--is-ancestor', changed.changedRemote, 'HEAD');
   console.log('PASS: changed bytes cannot inherit the old answer; exact recorded bytes apply without a stale-revision veto, preserving both newer histories.');
  }
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
 }
} finally {
 await writeFile(join(run, 'evidence', 'neo-home-apply-choice.json'), JSON.stringify(evidence, null, 2));
 db.close(); await transport.close();
}
