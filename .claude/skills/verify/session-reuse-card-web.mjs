import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { revealAsk } from './queue-ask.mjs';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const rpc = (name, input = {}) => {
  const reply = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!reply.error, JSON.stringify(reply));
  return reply.value ?? reply;
};
const opened = rpc('neo.open');
const askId = crypto.randomUUID();
const now = Date.now();
execFileSync('sqlite3', [`${run}/data/daemon.db`, `INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES('${askId}','${opened.sessionId}','Synthetic reuse settings','Choose how sessions are reused','open',${now},${now});`]);
const scope = { kind: 'global', key: '' };
const address = { pack: 'core', scope, key: 'sessionReuse' };
const alternatives = ['long_lived', 'per_ask', 'per_todo'].map((value) => [{ ...address, value }]);
const { questionId } = rpc('pack.preferences.ask', { askId, requestId: 'synthetic-reuse', alternatives, hold: false });
assert(questionId);
const delegation = { pack: 'delegation', scope, key: 'signIn' };
const delegationQuestion = rpc('pack.preferences.ask', {
  askId, requestId: 'synthetic-sign-in', hold: false,
  alternatives: [[{ ...delegation, value: 'self' }], [{ ...delegation, value: 'saved' }]],
}).questionId;
assert(delegationQuestion);
const coding = { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/repo' }, key: 'sessionStrategy' };
const codingQuestion = rpc('pack.preferences.ask', {
  askId, requestId: 'synthetic-coding', hold: false,
  alternatives: ['long_lived', 'per_task', 'per_pr'].map((value) => [{ ...coding, value }]),
}).questionId;
assert(codingQuestion);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.VERIFY_BROWSER });
const observed = {};
try {
  const code = rpc('device.pair.create', { kind: 'human', name: 'Synthetic browser' }).code;
  assert(code);
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor();
  await page.goto(`http://127.0.0.1:${port}/neo`);
  await page.getByRole('button', { name: /^Your work/ }).click();
  const card = await revealAsk(page, askId);
  const signIn = card.locator(`[id="neo-ref-question-${delegationQuestion}"]`);
  await signIn.waitFor();
  observed.delegationText = await signIn.innerText();
  assert(observed.delegationText.includes('Work continues using the default until you answer.'));
  assert(!observed.delegationText.includes('I sign in: I sign in'));
  const codingCard = card.locator(`[id="neo-ref-question-${codingQuestion}"]`);
  await codingCard.waitFor();
  observed.codingText = await codingCard.innerText();
  assert(observed.codingText.includes('How should coding sessions be reused in this repository?'));
  const body = card.locator(`[id="neo-ref-question-${questionId}"]`);
  await body.waitFor();
  observed.text = await body.innerText();
  observed.tables = await body.locator('table').count();
  observed.options = await body.locator('[data-choice-option]').allTextContents();
  assert(observed.text.includes('How should sessions be reused?'));
  assert(observed.text.includes('Reuse this matter’s worker and wait if it is busy.'));
  assert(observed.text.includes('Work continues using the default until you answer.'));
  assert.equal(observed.tables, 0);
  assert(observed.options.some((option) => option.includes('Use the default for now')));
  await page.screenshot({ path: `${run}/evidence/session-reuse-card.png`, fullPage: true });
  await body.getByRole('button', { name: /One session per matter/ }).click();
  for (let i = 0; i < 50; i++) {
    observed.saved = rpc('pack.preferences.get', address).preference?.value ?? null;
    if (observed.saved) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(observed.saved, 'per_ask');
  console.log('PASS: the card explains all choices without tables and selecting one saves per_ask');
} finally {
  await browser.close();
  writeFileSync(`${run}/evidence/session-reuse-card.json`, JSON.stringify(observed, null, 2));
}
