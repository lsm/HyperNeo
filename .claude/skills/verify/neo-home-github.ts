import { strict as assert } from 'node:assert';
import { Database } from 'bun:sqlite';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
const [port, run, phase = 'verify'] = process.argv.slice(2);
assert(port && run && port !== '8399', 'pass isolated port and run directory');
const log = await readFile(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`), 'not an isolated daemon');
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  return result.reply.value ?? result.reply;
}
const evidence: Record<string, unknown> = { phase };
const save = () => writeFile(`${run}/evidence/neo-home-github-${phase}.json`, JSON.stringify(evidence, null, 2));
if (phase === 'before') {
  evidence.result = await rpc('neo.home.github', { askId: 'synthetic-before' });
  await save();
  console.log(JSON.stringify(evidence));
  process.exit(0);
}
const root = `${run}/data/Neo`;
async function git(...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd: root, env: { HOME: `${run}/home`, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, error);
  return text.trim();
}
const calls = () => readFile(`${run}/evidence/home-gh.log`, 'utf8').catch(() => '');
if (phase === 'restart') {
  const before = JSON.parse(await readFile(`${run}/evidence/neo-home-github-verify.json`, 'utf8'));
  evidence.repeated = await rpc('neo.home.github', { questionId: before.proposed.questionId });
  evidence.calls = await calls();
  assert.deepEqual(evidence.repeated, before.created);
  assert.equal(String(evidence.calls).split('\n').filter((s) => s.startsWith('repo create ')).length, 1);
  await save();
  console.log('PASS: persisted human approval and creation receipt survive daemon restart without replay.');
  process.exit(0);
}
await mkdir(`${run}/bin`, { recursive: true });
await writeFile(`${run}/bin/gh`, `#!/bin/sh
set -eu
RUN="$(dirname "$0")/.."
printf '%s\n' "$*" >> "$RUN/evidence/home-gh.log"
case "$*" in
 'auth status') test ! -f "$RUN/unavailable" ;;
 'api user --jq .login') echo fixture-owner ;;
 'repo create fixture-owner/neo-home --private --source . --remote origin --push')
   git remote add origin "$RUN/remote.git"
   git push -u origin HEAD ;;
 *) exit 97 ;;
esac
`);
await chmod(`${run}/bin/gh`, 0o755);
await writeFile(`${run}/home/.gitconfig`, '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
const sessionId = (await rpc('neo.open')).sessionId;
const askId = crypto.randomUUID();
const db = new Database(`${run}/data/daemon.db`);
db.query("INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES (?,?,'Synthetic GitHub home','Review a private home remote','open',?,?)").run(askId, sessionId, Date.now(), Date.now());
db.close();
await rpc('neo.home.init');
await git('config', 'core.hooksPath', '.git/hooks');
await writeFile(`${root}/.git/hooks/pre-push`, '#!/bin/sh\nprintf executed > "$HOME/../evidence/home-hook-ran"\n', { mode: 0o755 });
await git('init', '--bare', `${run}/remote.git`);
if (phase === 'unavailable') await writeFile(`${run}/unavailable`, '');
const proposed = await rpc('neo.home.github', { askId });
evidence.proposed = proposed;
await save();
if (phase === 'unavailable') {
  const repeated = await rpc('neo.home.github', { askId });
  assert.equal(proposed.status, 'local');
  assert.deepEqual(repeated, proposed);
  assert.equal(await calls(), 'auth status\n');
  assert.equal(await git('remote'), '');
  evidence.repeated = repeated;
  evidence.calls = await calls();
  await save();
  console.log('PASS: unavailable GitHub stays local with one probe and no question or creation.');
  process.exit(0);
}
assert.equal(proposed.status, 'proposed');
const questionId = proposed.questionId;
evidence.question = await rpc('neo.question.get', { questionId });
evidence.missing = await rpc('neo.home.github', { questionId: 'unknown' });
evidence.open = await rpc('neo.home.github', { questionId });
assert.equal((evidence.missing as {ok:boolean}).ok, false);
assert.equal((evidence.open as {ok:boolean}).ok, false);
assert(!(await calls()).includes('repo create'));
assert.equal(await git('remote'), '');
if (phase === 'decline') {
  await rpc('neo.question.answer', { questionId, answer: 'no' });
  evidence.refused = await rpc('neo.home.github', { questionId });
  evidence.repeated = await rpc('neo.home.github', { askId });
  evidence.calls = await calls();
  assert.equal((evidence.refused as {ok:boolean}).ok, false);
  assert.deepEqual(evidence.repeated, proposed);
  assert(!String(evidence.calls).includes('repo create'));
  await save();
  console.log('PASS: human no stays local and the once-only proposal is not re-asked.');
  process.exit(0);
}
await rpc('neo.question.answer', { questionId, answer: 'yes' });
evidence.consent = await rpc('neo.question.get', { questionId });
evidence.created = await rpc('neo.home.github', { questionId });
evidence.repeated = await rpc('neo.home.github', { questionId });
evidence.proposalRetry = await rpc('neo.home.github', { askId });
evidence.head = await git('rev-parse', 'HEAD');
evidence.upstream = await git('rev-parse', '@{upstream}');
evidence.origin = await git('remote', 'get-url', 'origin');
evidence.status = await git('status', '--porcelain');
evidence.calls = await calls();
evidence.hookExecution = await readFile(`${run}/evidence/home-hook-ran`, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
await save();
assert.equal((evidence.consent as {answeredByHuman:boolean}).answeredByHuman, true);
assert.equal(evidence.hookExecution, null, 'daemon-side gh executed a writable home hook');
assert.equal((evidence.created as {status:string}).status, 'created');
assert.deepEqual(evidence.created, evidence.repeated);
assert.deepEqual(evidence.created, evidence.proposalRetry);
assert.equal(evidence.origin, `${run}/bin/../remote.git`);
assert.equal(evidence.upstream, evidence.head);
assert.equal(evidence.status, '');
assert.equal(String(evidence.calls).split('\n').filter((s) => s.startsWith('repo create ')).length, 1);
console.log('PASS: real RPC refuses missing/open consent, accepts recorded human yes, calls private creation once and pushes only to the synthetic bare remote.');
