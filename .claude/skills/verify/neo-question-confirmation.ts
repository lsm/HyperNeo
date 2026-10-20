import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const [port, run, phase = 'after'] = process.argv.slice(2);
if (!port || !run || port === '8399') throw new Error('usage: neo-question-confirmation.ts <test-port> <run-dir> [before|after]');
const log = await readFile(`${run}/daemon.log`, 'utf8');
if (!log.includes('HyperNeo Test Server') || !log.includes(`Database: ${run}/data/daemon.db`)) throw new Error('Not an isolated test daemon');
async function rpc(name: string, input: unknown = {}) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  if (await child.exited) throw new Error(JSON.stringify(result));
  return result.reply.value ?? result.reply;
}
const sessionId = (await rpc('neo.open')).sessionId;
if (!sessionId) throw new Error('Synthetic Neo session did not open');
const askId = crypto.randomUUID();
const db = new Database(`${run}/data/daemon.db`);
try {
  db.query("INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES (?,?,'Synthetic home proposal','Review the proposed home text','open',?,?)").run(askId, sessionId, Date.now(), Date.now());
} finally { db.close(); }
let legacy = JSON.parse(await readFile(`${run}/legacy-question.json`, 'utf8').catch(() => 'null'));
if (!legacy) {
  const asked = await rpc('neo.question.ask', { askId, kind: 'yesno', text: 'Keep the original ordinary question?', noLabel: 'No', yesLabel: 'Yes' });
  legacy = { id: asked.question.id, text: asked.question.text };
  await writeFile(`${run}/legacy-question.json`, JSON.stringify(legacy));
}
const legacyRead = await rpc('neo.question.get', { questionId: legacy.id });
const confirm = { path: 'projects/verify/mandate.md', sha256: createHash('sha256').update('Synthetic new mandate.\n').digest('hex') };
const input = { askId, kind: 'yesno', text: `Old mandate: old text. New mandate: Synthetic new mandate.\nPath: ${confirm.path}\nSHA-256: ${confirm.sha256}`, noLabel: 'Keep old text', yesLabel: 'Use proposed text', confirm };
const created = await rpc('neo.question.ask', input);
const read = await rpc('neo.question.get', { questionId: created.question?.id });
const evidence: Record<string, unknown> = { phase, legacy, legacyRead, confirm, created, read };
await writeFile(`${run}/evidence/neo-question-confirmation-${phase}.json`, JSON.stringify(evidence, null, 2));
if (phase === 'before') throw new Error('Baseline question silently drops the proposed path/hash binding');
const badBody = await rpc('neo.question.ask', { ...input, text: 'Missing visible path/hash' });
const answered = await rpc('neo.question.answer', { questionId: created.question.id, answer: 'yes' });
const after = await rpc('neo.question.get', { questionId: created.question.id });
const stillBlocked = await rpc('neo.home.save', { path: confirm.path, content: 'Synthetic new mandate.\n', message: 'Not wired in this slice', questionId: created.question.id });
Object.assign(evidence, { badBody, answered, after, stillBlocked });
await writeFile(`${run}/evidence/neo-question-confirmation-after.json`, JSON.stringify(evidence, null, 2));
if (JSON.stringify(created.question.confirm) !== JSON.stringify(confirm) || JSON.stringify(read.question.confirm) !== JSON.stringify(confirm) || read.answeredByHuman || !answered.ok || !after.answeredByHuman || after.question.state !== 'answered' || after.question.answer !== 'yes' || JSON.stringify(after.question.confirm) !== JSON.stringify(confirm) || badBody.ok || !badBody.reason?.includes('confirmation_body') || legacyRead.question.text !== legacy.text || legacyRead.question.confirm !== null || stillBlocked.ok || !stillBlocked.reason?.includes('confirmation_required')) throw new Error('Question binding contract failed');
console.log('PASS: real ask/get/answer RPC retains the exact path/hash, exposes only the human answer, preserves the legacy question, rejects an incomplete body, and leaves protected saves blocked for the next slice.');
