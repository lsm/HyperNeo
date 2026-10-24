import assert from 'node:assert/strict';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const [portText, runText] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(port > 0 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const dbPath = join(run, 'data/daemon.db');
assert(!existsSync(dbPath), 'fresh synthetic DB required');
mkdirSync(join(run, 'evidence'), { recursive: true });
const evidence: unknown[] = [];
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath }), verbose: false });
app.server.stop();
const files = new Map([...new Bun.Glob('**/*').scanSync({ cwd: 'packages/web/dist', onlyFiles: true })].map((path) => [`/${path}`, Bun.file(resolve('packages/web/dist', path))]));
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(request, server) {
    if (new URL(request.url).pathname === '/ws') {
      if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, server.requestIP(request)?.address ?? null) } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    return new Response(files.get(new URL(request.url).pathname) ?? Bun.file(resolve('packages/web/dist/neo/index.html')));
  },
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
});
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready();
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  const rpc = (name: string, input: unknown = {}) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`RPC timeout: ${name}`)), 10000);
    ws!.onmessage = (event) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer);
      evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const root = await rpc('neo.open');
  assert(root.ok);
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root.sessionId, role: 'neo' }));
  const mcp = async (name: string, input: unknown) => {
    const reply = await handler({ name, input });
    evidence.push({ name, input, mcp: reply });
    assert(!reply.isError, JSON.stringify(reply));
    return JSON.parse(reply.content[0].text);
  };
  for (const language of ['en', 'zh-Hans'] as const) {
    app.db.updateGlobalSettings({ language });
    const askId = `synthetic-settings-${language}`;
    store.openAsk({ id: askId, projectId: null, sessionId: root.sessionId, originMessageId: null, title: language === 'en' ? 'Repository settings' : '仓库设置', request: 'Synthetic verification only', createdAt: Date.now() });
    const values = [
      { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/one' }, key: 'mergePolicy', value: 'review_bot' },
      { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/two' }, key: 'mergePolicy', value: 'human' },
      { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/one' }, key: 'reviewBot', value: 'synthetic-bot' },
      { pack: 'coding', scope: { kind: 'repo', key: 'synthetic/one' }, key: 'humanSignoff', value: ['docs/**', 'label:needs-human', 'docs/a|b/**', 'docs/`draft`/**', 'docs\\windows/**'] },
    ];
    const receipt = await mcp('pack.preferences.ask', { askId, requestId: askId, values });
    assert(receipt.ok);
    const { question } = await rpc('neo.question.get', { questionId: receipt.questionId });
    const bound = db.prepare('SELECT values_json, question_text FROM neo_pack_preference_proposals WHERE question_id=?').get(question.id) as { values_json: string; question_text: string };
    assert.equal(bound.values_json, JSON.stringify(values));
    assert.equal(bound.question_text, question.text);
    app.db.updateGlobalSettings({ language: language === 'en' ? 'zh-Hans' : 'en' });
    assert.equal((await mcp('pack.preferences.ask', { askId, requestId: askId, values })).questionId, question.id);
    assert.equal((await rpc('neo.question.get', { questionId: question.id })).question.text, question.text);
    app.db.updateGlobalSettings({ language });
    writeFileSync(join(run, 'fixture.json'), JSON.stringify({ askId, question: store.getQuestion(question.id), language }));
    const browser = Bun.spawn([process.env.VERIFY_NODE!, '.claude/skills/verify/pack-settings-readable-table.mjs', String(port), run], { stdout: 'inherit', stderr: 'inherit' });
    assert.equal(await browser.exited, 0, 'headless question render failed');
    const answer = await rpc('neo.question.get', { questionId: question.id });
    assert.equal(answer.question.answer, 'yes');
    assert.equal(answer.answeredByHuman, true);
    const saved = (await rpc('pack.preferences.list')).preferences.filter((row: { key: string }) => row.key !== 'watchedRepos');
    for (const value of values) assert(saved.some((row: any) => row.pack === value.pack && row.scope.key === value.scope.key && row.key === value.key && JSON.stringify(row.value) === JSON.stringify(value.value) && row.setBy === 'human'));
    evidence.push({ language, bound, saved, browser: JSON.parse(readFileSync(join(run, `evidence/table-${language}.json`), 'utf8')) });
  }
  console.log(`PASS: bilingual tables and real browser approval apply exact bound values. ${run}/evidence/observed.json`);
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  ws?.close();
  server.stop(true);
  await app.cleanup();
}
