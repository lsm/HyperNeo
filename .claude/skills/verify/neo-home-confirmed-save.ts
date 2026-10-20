import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const [port, run, phase = 'after'] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-home-confirmed-save.ts <test-port> <run-dir> [before|after]');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(JSON.stringify(result));
  return result.reply.value ?? result.reply;
}
const root = `${run}/data/Neo`;
async function git(...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd: root, env: { HOME: `${run}/home`, PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' });
  const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(error);
  return text.trim();
}
await writeFile(`${run}/home/.gitconfig`, '[user]\n name = Verify Neo\n email = verify@example.invalid\n[commit]\n gpgsign = false\n');
const sessionId = (await rpc('neo.open')).sessionId;
const askId = crypto.randomUUID();
const db = new Database(`${run}/data/daemon.db`);
try { db.query("INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES (?,?,'Synthetic protected save','Review the proposed home text','open',?,?)").run(askId, sessionId, Date.now(), Date.now()); } finally { db.close(); }
await rpc('neo.home.init');
const input = { path: 'projects/verify/mandate.md', content: 'Confirmed new mandate 🦊.\n', message: 'Adopt verified mandate' };
async function ask(value = input) {
  const confirm = { path: value.path, sha256: createHash('sha256').update(value.content).digest('hex') };
  const text = `Old: previous mandate. New: ${value.content}\nPath: ${confirm.path}\nSHA-256: ${confirm.sha256}`;
  return (await rpc('neo.question.ask', { askId, kind: 'yesno', text, noLabel: 'Keep old', yesLabel: 'Use new', confirm })).question.id;
}
const decisions = `${root}/projects/verify/decisions.md`;
await rpc('neo.home.save', { path: 'projects/verify/decisions.md', content: 'Prior decision.\n', message: 'Seed synthetic history' });
const before = await git('rev-parse', 'HEAD');
const missing = await rpc('neo.home.save', input);
const questionId = await ask();
const open = await rpc('neo.home.save', { ...input, questionId });
await rpc('neo.question.answer', { questionId, answer: 'no' });
const no = await rpc('neo.home.save', { ...input, questionId });
const yesId = await ask();
await rpc('neo.question.answer', { questionId: yesId, answer: 'yes' });
const question = await rpc('neo.question.get', { questionId: yesId });
const wrongHash = await rpc('neo.home.save', { ...input, content: 'Different unapproved content.', questionId: yesId });
const wrongPath = await rpc('neo.home.save', { ...input, path: 'direction.md', questionId: yesId });
const unchangedBeforeYes = before === await git('rev-parse', 'HEAD') && await readFile(decisions, 'utf8') === 'Prior decision.\n' && await readFile(`${root}/${input.path}`).then(() => false, () => true);
const accepted = await rpc('neo.home.save', { ...input, questionId: yesId });
const evidence: Record<string, unknown> = { phase, input, before, missing, open, no, question, wrongHash, wrongPath, unchangedBeforeYes, accepted };
const saveEvidence = () => writeFile(`${run}/evidence/neo-home-confirmed-save-${phase}.json`, JSON.stringify(evidence, null, 2));
await saveEvidence();
if (phase === 'before') throw new Error('Observed pre-H2 save gate: matching human yes still refused; evidence retained');
if ([missing, open, no, wrongHash, wrongPath].some((reply) => reply.ok || !reply.reason?.includes('confirmation')) || !unchangedBeforeYes || !question.answeredByHuman || !accepted.ok) throw new Error('Protected save authorization contract failed');
const content = await readFile(`${root}/${input.path}`, 'utf8');
const history = await readFile(decisions, 'utf8');
const paths = await git('show', '--format=', '--name-only', 'HEAD');
const commitMessage = await git('log', '-1', '--format=%B');
const repeated = await rpc('neo.home.save', { ...input, questionId: yesId });
const retryUnchanged = accepted.commit === repeated.commit && history === await readFile(decisions, 'utf8');
const next = { ...input, content: 'Confirmed follow-up mandate.\n' };
const nextId = await ask(next);
await rpc('neo.question.answer', { questionId: nextId, answer: 'yes' });
await git('config', 'user.name', '');
await git('config', 'user.email', '');
const failure = await rpc('neo.home.save', { ...next, questionId: nextId });
const rollback = content === await readFile(`${root}/${input.path}`, 'utf8') && history === await readFile(decisions, 'utf8') && accepted.commit === await git('rev-parse', 'HEAD') && !await git('status', '--porcelain');
await git('config', 'user.name', 'Verify Neo');
await git('config', 'user.email', 'verify@example.invalid');
const retry = await rpc('neo.home.save', { ...next, questionId: nextId });
Object.assign(evidence, { content, history, paths, commitMessage, repeated, retryUnchanged, failure, rollback, retry, finalStatus: await git('status', '--porcelain') });
await saveEvidence();
if (content !== input.content || !history.startsWith('Prior decision.\n') || !history.includes(yesId) || !history.includes(question.question.confirm.sha256) || paths !== 'projects/verify/decisions.md\nprojects/verify/mandate.md' || !commitMessage.includes(`Neo-Confirmed-By: question ${yesId}`) || !retryUnchanged || !String(failure.error).includes('Author identity unknown') || !rollback || !retry.ok || evidence.finalStatus) throw new Error('Protected paired commit/rollback contract failed');
console.log('PASS: real RPC refuses missing/open/no/mismatched confirmations, accepts human yes, commits both files with trailer, retries unchanged and rolls both files back after commit failure.');
