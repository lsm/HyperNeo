process.env.HYPERNEO_SPACE ??= 'on';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const [portText, runText, hold] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath));
mkdirSync(join(run, 'evidence'), { recursive: true });
const neo = 'neo:10000000-0000-4000-8000-000000000003';
const evidence: unknown[] = [];
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath }),
  verbose: false,
});
await app.spaceRuntimeService.ready();
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
  headers: { authorization: `Bearer ${await readLocalCredential()}` },
} as unknown as string[]);
await new Promise<void>((done, fail) => {
  ws.onopen = () => done();
  ws.onerror = () => fail(new Error('connect'));
});
const rpc = (name: string, input: unknown) =>
  new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`RPC timeout ${name}`)), 10000);
    ws.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      evidence.push({ name, input, reply: reply.data ?? reply.error });
      if (reply.error) fail(new Error(JSON.stringify(reply.error)));
      else done(reply.data);
    };
    ws.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method: 'operation.invoke',
        data: { name, input },
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
const handler = createOperationMcpHandler(
  () => app.sessionManager.getOperationRegistry(),
  () => ({ sessionId: neo, role: 'neo' })
);
const mcp = async (name: string, input: unknown) => {
  const result = await handler({ name, input });
  evidence.push({ name, input, mcp: result });
  const parsed = JSON.parse(result.content[0].text);
  if (parsed?.ok === false || result.isError)
    console.error('MCP refusal', name, JSON.stringify(parsed).slice(0, 800));
  return parsed;
};
const db = app.db.getDatabase();
db.exec(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
  VALUES ('${neo}','Synthetic Neo','/tmp','2026-10-21T00:00:00Z','2026-10-21T00:00:00Z','active','{"queryMode":"manual"}','{}')`);
new NeoRepository(db).reserveBinding({ sessionId: neo, kind: 'neo', projectId: null });
const asks = new NeoAskTodoRepository(db);
for (const id of ['synthetic-ask', 'synthetic-ask-many', 'synthetic-ask-detailed', 'synthetic-ask-bad', 'synthetic-ask-raw', 'synthetic-ask-invalid', 'synthetic-ask-numeric', 'synthetic-ask-ambiguous'])
  asks.openAsk({
    id,
    projectId: null,
    sessionId: neo,
    originMessageId: null,
    title: 'Synthetic layout choice',
    request: 'Pick a layout for the synthetic card',
    createdAt: 1,
  });
const options = [
  '保留现在的列表布局，只把每一行的间距、字号和状态标签重新调整一遍，让长标题在手机上也能完整显示而不被截断',
  'Switch every card to the compact table layout with sortable columns, sticky headers, and a much longer description that keeps going',
  'Cards',
];
const retireWhen = { pack: 'core', kind: 'evidence', params: { path: join(run, 'not-created') } };
const ask = async (askId: string, input: Record<string, unknown>) => {
  const result = await mcp('neo.question.ask', { askId, kind: 'choice', multiple: false, retireWhen, ...input });
  return result.question?.id as string;
};
const single = await ask('synthetic-ask', { text: 'Which layout?', options });
const many = await ask('synthetic-ask-many', { text: 'Which layouts should stay?', options, multiple: true });
const hotels = ['Park Hyatt', 'Hotel Gracery', 'Neither, keep looking'];
const details = { 'Park Hyatt': '3 minutes from the station, 4,200 a night', 'Hotel Gracery': '12 minutes, 1,600 a night' };
const detailed = await ask('synthetic-ask-detailed', {
  text: 'Which hotel?',
  options: hotels,
  details,
  recommended: 'Hotel Gracery',
});
const raw = await ask('synthetic-ask-raw', { text: 'Which hotel?', options: hotels });
const invalid = await ask('synthetic-ask-invalid', { text: 'Which hotel?', options: hotels, multiple: true });
const numeric = await ask('synthetic-ask-numeric', { text: 'How many days?', options: ['7', '30', '90'] });
const ambiguous = await ask('synthetic-ask-ambiguous', { text: 'How many days?', options: ['30', '1', '90'] });
const snapshot = (await rpc('neo.snapshot', {})).todoAsks;
for (const entry of snapshot)
  for (const question of entry.questions ?? []) {
    if ([single, many, detailed].includes(question.id))
      assert.deepEqual(question.optionLabels, ['1', '2', '3'], 'snapshot numbers the options');
    if (question.id === detailed) {
      assert.deepEqual(question.optionDetails, details, 'snapshot carries option details');
      assert.equal(question.recommended, 'Hotel Gracery', 'snapshot carries the recommended option');
      assert.equal(question.answer, null, 'recommending does not answer');
    }
  }
if (hold === 'hold') {
  writeFileSync(join(run, 'evidence/neo-choice-numbers.json'), JSON.stringify(evidence, null, 2));
  console.log(`HOLD: synthetic choice questions open on ${port}; stop the process when done.`);
  await new Promise(() => {});
}
const reply = async (questionId: string, content: string) => {
  const requestId = crypto.randomUUID();
  const sent = await rpc('neo.message.send', {
    sessionId: neo,
    requestId,
    content,
    replyTo: { kind: 'question', id: questionId },
  });
  assert.equal(sent.ok, true);
  return requestId;
};
for (const words of ['7', '0', '七', 'seventh', '1 和 7', '第十个', '十二', '100']) {
  await reply(invalid, words);
  assert.equal(asks.getQuestion(invalid)?.state, 'open', `${words} must not close the card`);
}
assert.throws(() => db.prepare('UPDATE neo_questions SET option_details_json=? WHERE id=?').run('{', detailed), 'invalid details JSON must be refused');
await reply(numeric, '30');
assert.deepEqual(asks.getQuestion(numeric)?.answer, ['30'], 'exact numeric option text answers the card');
await reply(ambiguous, '1');
assert.deepEqual(asks.getQuestion(ambiguous)?.answer, ['30'], 'a visible option number takes precedence');
const requestId = await reply(single, '第二个吧');
await reply(many, '选1、3');
await reply(detailed, '选二');
await reply(raw, 'no one');
const unknown = await mcp('neo.question.ask', {
  askId: 'synthetic-ask-bad',
  kind: 'choice',
  text: 'Which hotel?',
  options: hotels,
  details: { Gracery: 'cheap' },
  multiple: false,
  retireWhen,
});
assert.equal(unknown.ok, false, 'a detail for a missing option is refused');
assert.match(unknown.reason, /option_unknown/);
const read = async (questionId: string) =>
  db.prepare('SELECT answer, answered_by FROM neo_questions WHERE id = ?').get(questionId) as {
    answer: string;
    answered_by: string;
  };
assert.deepEqual(JSON.parse((await read(single)).answer), [options[1]]);
assert.equal((await read(single)).answered_by, 'chat');
assert.deepEqual(JSON.parse((await read(many)).answer), [options[0], options[2]]);
assert.deepEqual(JSON.parse((await read(detailed)).answer), ['Hotel Gracery']);
assert.equal(JSON.parse((await read(raw)).answer), 'no one', 'words that are not a number stay the human\'s own');
const prompt = JSON.parse(
  (
    db.prepare('SELECT sdk_message FROM sdk_messages WHERE sdk_uuid = ?').get(requestId) as {
      sdk_message: string;
    }
  ).sdk_message
);
const fact = prompt.message.content.find((block: { text?: string }) =>
  block.text?.startsWith('<reference')
).text;
assert.equal(fact, `<reference question="${single}" ask="synthetic-ask">\nWhich layout?\n</reference>\n\n`);
evidence.push({
  fact,
  single: await read(single),
  many: await read(many),
  detailed: await read(detailed),
  raw: await read(raw),
  unknown: unknown.reason,
});
writeFileSync(join(run, 'evidence/neo-choice-numbers.json'), JSON.stringify(evidence, null, 2));
console.log(
  `PASS: options numbered 1-3 on the snapshot; details and recommended carried; "第二个吧" answered ${options[1]}; "选1、3" answered two; "选二" answered Hotel Gracery; "no one" stayed raw; unknown detail refused`
);
ws.close();
await app.cleanup();
process.exit(0);
