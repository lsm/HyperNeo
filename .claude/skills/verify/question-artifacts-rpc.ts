import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, phase, port = '9474'] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
assert.notEqual(port, '8399');
if (phase === 'seed') {
  const child = Bun.spawn([
    process.execPath,
    fileURLToPath(new URL('./preview-register.ts', import.meta.url)),
    root,
    'seed',
  ], { env: process.env, stdout: 'inherit', stderr: 'inherit' });
  assert.equal(await child.exited, 0);
} else {
  const rpc = async (name: string, input: unknown) => {
    const child = Bun.spawn([
      process.execPath,
      fileURLToPath(new URL('./rpc.ts', import.meta.url)),
      name,
      JSON.stringify(input),
    ], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
    const result = JSON.parse(await new Response(child.stdout).text());
    assert.equal(await child.exited, 0);
    assert(!result.reply.error, JSON.stringify(result));
    return result.reply.value ?? result.reply;
  };
  const evidence = join(root, 'evidence', 'question-artifacts.json');
  const saved = phase === 'capture' ? null : JSON.parse(readFileSync(evidence, 'utf8'));
  const registered = saved?.registered ?? await rpc('artifact.file.register', {
    requestId: 'question-report', context: { kind: 'todo', id: 'todo' },
    path: 'report.md', title: 'Synthetic review report',
  });
  assert(registered.accepted, JSON.stringify(registered));
  const draft = {
    askId: 'ask', kind: 'yesno', text: 'Review the attached synthetic report?',
    noLabel: 'Keep current', yesLabel: 'Accept report', artifacts: [registered.artifact],
  };
  const question = saved?.question ?? (await rpc('neo.question.ask', draft)).question;
  assert(question, 'question missing');
  assert.deepEqual(question.artifacts, [registered.artifact]);
  const refused = [];
  if (phase === 'capture') {
    for (const ref of [
      { ...registered.artifact, artifactId: 'missing' },
      { ...registered.artifact, title: 'Forged title' },
      { ...registered.artifact, daemonId: crypto.randomUUID() },
    ]) {
      const reply = await rpc('neo.question.ask', {
        ...draft, artifacts: [ref], replaces: question.id,
      });
      assert.equal(reply.ok, false);
      assert.match(reply.reason, /^invalid_artifact_reference:/);
      refused.push(reply.reason);
    }
  }
  const got = await rpc('neo.question.get', { questionId: question.id });
  assert.deepEqual(got.question.artifacts, [registered.artifact]);
  assert.equal(got.question.state, 'open');
  const snapshot = await rpc('neo.snapshot', {});
  const card = snapshot.todoAsks?.flatMap((entry: { questions: { id: string }[] }) => entry.questions)
    .find((item: { id: string }) => item.id === question.id);
  assert(card, 'question card missing from snapshot');
  assert.deepEqual(card.artifacts, [registered.artifact]);
  const content = await rpc('artifact.file.read', { artifactId: registered.artifact.artifactId });
  assert(content.accepted);
  assert.equal(Buffer.from(content.data, 'base64').toString(), '# Synthetic 🦊\nComplete bytes\n');
  writeFileSync(phase === 'capture' ? evidence : join(root, 'evidence', 'question-artifacts-restart.json'),
    JSON.stringify({ registered, question, card, refused, content }, null, 2));
  console.log(`PASS: ${phase} question reference persists, snapshot carries it, registered bytes open`);
}
