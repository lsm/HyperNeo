import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-question-closed-references.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
const rpc = (name, input = {}) => {
  const reply = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!reply.error, JSON.stringify(reply));
  return reply.value ?? reply;
};
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const now = Date.now();
const sql = (statement) => execFileSync('sqlite3', [`${run}/data/daemon.db`, statement]);

const opened = rpc('neo.open');
assert(opened.ok);
const ask = crypto.randomUUID();
sql(`INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},'Synthetic stale references','Synthetic verification only','open',${now},${now});`);

const evidence = {};

const stale = crypto.randomUUID();
const asked = rpc('neo.question.ask', { askId: ask, kind: 'reply', text: 'Which draft?', replyTo: [stale] });
assert.equal(asked.ok, true, JSON.stringify(asked));
assert.deepEqual(asked.question.replyTo ?? [], []);
evidence.omittedReplyTo = asked.question;

const answered = rpc('neo.question.answer', { questionId: asked.question.id, answer: 'The second one.' });
assert.equal(answered.ok, true, JSON.stringify(answered));
const doubleAnswer = rpc('neo.question.answer', { questionId: asked.question.id, answer: 'Changed my mind.' });
assert.equal(doubleAnswer.ok, false, JSON.stringify(doubleAnswer));

const replacement = rpc('neo.question.ask', { askId: ask, kind: 'reply', text: 'Which draft for the rerun?', replaces: asked.question.id });
assert.equal(replacement.ok, true, JSON.stringify(replacement));
assert.equal(replacement.question.state, 'open');
const old = rpc('neo.question.get', { questionId: asked.question.id });
assert.equal(old.question.state, 'answered');
assert.equal(old.question.replacedBy ?? null, null);
evidence.replacedClosed = { replacement: replacement.question, old: old.question };

const retiredOnce = rpc('neo.question.retire', { questionId: replacement.question.id, reason: 'moot' });
assert.equal(retiredOnce.ok, true, JSON.stringify(retiredOnce));
const retiredTwice = rpc('neo.question.retire', { questionId: replacement.question.id, reason: 'moot again' });
assert.equal(retiredTwice.ok, true, JSON.stringify(retiredTwice));
assert.equal(retiredTwice.question.retiredReason, 'moot');
const retireAnswered = rpc('neo.question.retire', { questionId: asked.question.id, reason: 'tidying' });
assert.equal(retireAnswered.ok, true, JSON.stringify(retireAnswered));
assert.equal(retireAnswered.question.state, 'answered');
evidence.retiredClosed = { retiredTwice: retiredTwice.question, retireAnswered: retireAnswered.question };

sql(`INSERT INTO neo_questions(id,ask_id,text,kind,start_todos,created_at) VALUES('start-q',${quote(ask)},'Start these?','start','[]',${now});`);
const retireStart = rpc('neo.question.retire', { questionId: 'start-q', reason: 'moot' });
assert.equal(retireStart.ok, false);
assert.match(retireStart.reason, /^start_question:/);
const replaceStart = rpc('neo.question.ask', { askId: ask, kind: 'reply', text: 'Swap?', replaces: 'start-q' });
assert.equal(replaceStart.ok, false);
assert.match(replaceStart.reason, /^start_question:/);
evidence.startBoundary = { retireStart, replaceStart };

mkdirSync(`${run}/evidence`, { recursive: true });
writeFileSync(`${run}/evidence/neo-question-closed-references.json`, JSON.stringify(evidence, null, 1));
console.log('PASS question closed-reference gates:', run);
