import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

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
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
  return JSON.parse(result.content[0].text);
};
const db = app.db.getDatabase();
db.exec(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata)
  VALUES ('${neo}','Synthetic Neo','/tmp','2026-10-21T00:00:00Z','2026-10-21T00:00:00Z','active','{"queryMode":"manual"}','{}')`);
new NeoRepository(db).reserveBinding({ sessionId: neo, kind: 'neo', projectId: null });
new NeoAskTodoRepository(db).openAsk({
  id: 'synthetic-ask',
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
const ask = async (multiple: boolean) =>
  (
    await mcp('neo.question.ask', {
      askId: 'synthetic-ask',
      kind: 'choice',
      text: multiple ? 'Which layouts should stay?' : 'Which layout?',
      options,
      multiple,
    })
  ).question.id as string;
const single = await ask(false);
const many = await ask(true);
const entry = (await rpc('neo.snapshot', {})).todoAsks.find(
  (item: { ask: { id: string } }) => item.ask.id === 'synthetic-ask'
);
for (const question of entry.questions)
  assert.deepEqual(question.optionLabels, ['A', 'B', 'C'], 'snapshot carries optionLabels');
if (hold === 'hold') {
  writeFileSync(join(run, 'evidence/neo-choice-letters.json'), JSON.stringify(evidence, null, 2));
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
const requestId = await reply(single, 'B吧');
await reply(many, '选A、C');
const read = async (questionId: string) =>
  db.prepare('SELECT answer, answered_by FROM neo_questions WHERE id = ?').get(questionId) as {
    answer: string;
    answered_by: string;
  };
assert.deepEqual(JSON.parse((await read(single)).answer), [options[1]]);
assert.equal((await read(single)).answered_by, 'chat');
assert.deepEqual(JSON.parse((await read(many)).answer), [options[0], options[2]]);
const prompt = JSON.parse(
  (
    db.prepare('SELECT sdk_message FROM sdk_messages WHERE sdk_uuid = ?').get(requestId) as {
      sdk_message: string;
    }
  ).sdk_message
);
const fact = prompt.message.content.find((block: { text?: string }) =>
  block.text?.startsWith('The human answered')
).text;
assert.equal(fact, `The human answered your question "Which layout?" with B (${options[1]}):`);
evidence.push({ fact, single: await read(single), many: await read(many) });
writeFileSync(join(run, 'evidence/neo-choice-letters.json'), JSON.stringify(evidence, null, 2));
console.log(`PASS: optionLabels A-C on the snapshot; "B吧" answered ${options[1]}; fact: ${fact}`);
ws.close();
await app.cleanup();
process.exit(0);
