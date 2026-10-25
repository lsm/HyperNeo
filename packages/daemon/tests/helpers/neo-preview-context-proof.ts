import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageHub, WebSocketClientTransport } from '../../../shared/src/mod.ts';
import type { NeoConversationAsk } from '../../../shared/src/types/neo-conversation-ask.ts';
import type { NeoPreviewReference } from '../../../shared/src/types/neo-preview-context.ts';
import { createDaemonApp } from '../../src/app.ts';
import { getConfig } from '../../src/config.ts';
import { NeoAskTodoRepository } from '../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoRepository } from '../../src/storage/repositories/neo-repository.ts';
import { NeoTodoSessionRepository } from '../../src/storage/repositories/neo-todo-session-repository.ts';
import { submitNeoDraft } from '../../../web/src/neo/neo-intake.ts';
import { presentConversationAskPage } from '../../../web/src/neo/conversation-ask-client.ts';

const run = realpathSync(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const seed = Bun.spawn(
  [
    process.execPath,
    fileURLToPath(
      new URL('../../../../.claude/skills/verify/preview-register.ts', import.meta.url)
    ),
    run,
    'seed',
  ],
  { env: process.env, stdout: 'pipe', stderr: 'pipe' }
);
assert.equal(await seed.exited, 0, await new Response(seed.stderr).text());
const conversationId = '10000000-0000-4000-8000-000000000001';
const sessionId = `neo:${conversationId}`;
const requestId = '20000000-0000-4000-8000-000000000001';
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
let hub: MessageHub;
const evidence: Record<string, unknown> = { providerTurns: 0, guiTests: false };
async function start() {
  app = await createDaemonApp({
    config: getConfig({
      host: '127.0.0.1',
      port: 0,
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: run,
    }),
    disableWorktrees: true,
    disableGoalProcessing: true,
    standalone: false,
    verbose: false,
  });
  assert.notEqual(app.server.port, 8399);
  hub = new MessageHub({ defaultSessionId: 'global' });
  transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${app.server.port}/ws`,
    autoReconnect: false,
  });
  hub.registerTransport(transport);
  await transport.initialize();
}
async function stop() {
  await transport?.close();
  transport = undefined;
  await app?.cleanup();
  app = undefined;
}
function database() {
  assert(app);
  return app.db;
}
const rpc = <T>(name: string, input: unknown) =>
  hub.request<T>('operation.invoke', { name, input });
try {
  await start();
  await database().createSession({
    id: sessionId,
    title: 'Synthetic Preview context',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  assert(
    new NeoRepository(database().getDatabase()).reserveBinding({
      sessionId,
      kind: 'neo',
      projectId: null,
    })
  );
  const work = new NeoAskTodoRepository(database().getDatabase());
  work.openAsk({
    id: 'preview-ask',
    sessionId,
    projectId: null,
    originMessageId: 'source',
    title: 'Preview context',
    request: 'Discuss this registered report',
    createdAt: 1,
  });
  work.addTodo(
    'preview-todo',
    'preview-ask',
    { title: 'Report', doneWhen: '', check: null, instruction: '', named: null },
    1
  );
  const owners = new NeoTodoSessionRepository(database().getDatabase());
  owners.create('preview-todo', {
    verb: 'start',
    adapter: 'hyperneo',
    place: { machine: 'synthetic', name: 'Synthetic', folder: join(run, 'workspace') },
  });
  owners.recordRef('preview-todo', { adapter: 'hyperneo', id: 'worker' });
  const registration = await rpc<{ accepted: boolean; artifact: { artifactId: string } }>(
    'artifact.file.register',
    {
      requestId: 'context-register',
      context: { kind: 'todo', id: 'preview-todo' },
      path: 'report.md',
      title: 'Synthetic Preview report',
    }
  );
  assert.equal(registration.accepted, true);
  const artifactId = registration.artifact.artifactId;
  const metadata = await rpc<{ accepted: boolean; metadata: { sha256: string } }>(
    'artifact.file.get',
    { artifactId }
  );
  assert.equal(metadata.accepted, true);
  const previewContext = { artifactId, snapshot: metadata.metadata.sha256 };
  const reference: NeoPreviewReference = {
    ...previewContext,
    displayName: 'Synthetic Preview report',
    state: 'available',
  };
  const input = {
    sessionId,
    requestId,
    content: 'Please discuss this exact snapshot.',
    previewContext,
  };
  const first = await submitNeoDraft(
    { sessionId, requestId, text: input.content, previewContext: reference },
    async () => hub
  );
  assert(first.ok && first.created);
  assert.deepEqual(first.previewContext, reference);
  assert(!JSON.stringify(first).includes('sourcePath'));
  assert(!JSON.stringify(first).includes(run));
  async function readContext() {
    const asks = await rpc<{ ok: boolean; items: NeoConversationAsk[] }>(
      'neo.conversation.asks.read',
      { conversationId, imageRefs: true }
    );
    const conversation = await rpc<{
      ok: boolean;
      items: { role: string; ask?: NeoConversationAsk }[];
    }>('neo.conversation.read', { conversationId });
    assert(asks.ok && conversation.ok);
    const projected = presentConversationAskPage(asks, { conversationId, after: 0, limit: 50 });
    assert('value' in projected);
    const directAsk = projected.value.items.find((ask) => ask.requestId === requestId);
    const combinedAsk = conversation.items.find(
      (item) => item.role === 'human' && item.ask?.requestId === requestId
    )?.ask;
    assert(directAsk && combinedAsk);
    const direct = directAsk.previewContext;
    const combined = combinedAsk.previewContext;
    assert.deepEqual(combined, direct);
    return direct;
  }
  assert.deepEqual(await readContext(), reference);
  const before = database()
    .getDatabase()
    .prepare('SELECT sdk_message FROM sdk_messages WHERE sdk_uuid = ?')
    .get(requestId) as { sdk_message: string };
  const prompt = JSON.parse(before.sdk_message);
  assert.deepEqual(prompt.previewContext, reference);
  assert(JSON.stringify(prompt.message.content).includes(artifactId));
  assert(JSON.stringify(prompt.message.content).includes(previewContext.snapshot));
  const wrong = await rpc<{ ok: boolean }>('neo.message.send', {
    ...input,
    requestId: '20000000-0000-4000-8000-000000000002',
    previewContext: { ...previewContext, snapshot: '0'.repeat(64) },
  });
  assert.equal(wrong.ok, false);
  owners.recordRef('preview-todo', { adapter: 'hyperneo', id: 'worker', daemon: 'remote' });
  assert.deepEqual(await readContext(), { ...reference, state: 'unavailable' });
  assert.equal(
    (await rpc<{ accepted: boolean }>('artifact.file.read', { artifactId })).accepted,
    false
  );
  const retry = await rpc<typeof first>('neo.message.send', input);
  assert(retry.ok && !retry.created);
  assert.deepEqual(retry.previewContext, reference);
  const conflict = await rpc<{ ok: boolean }>('neo.message.send', {
    ...input,
    previewContext: undefined,
  });
  assert.equal(conflict.ok, false);
  const count = () => {
    const raw = database().getDatabase();
    const prompts = raw
      .prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_uuid = ?')
      .get(requestId) as { n: number };
    const jobs = raw
      .prepare(
        "SELECT COUNT(*) AS n FROM job_queue WHERE json_extract(payload,'$.messageUuid') = ?"
      )
      .get(requestId) as { n: number };
    assert.equal(prompts.n, 1);
    assert.equal(jobs.n, 1);
    const current = raw
      .prepare('SELECT sdk_message FROM sdk_messages WHERE sdk_uuid = ?')
      .get(requestId) as { sdk_message: string };
    assert.equal(current.sdk_message, before.sdk_message);
  };
  count();
  await stop();
  await start();
  assert.deepEqual(await readContext(), { ...reference, state: 'unavailable' });
  const replay = await submitNeoDraft(
    { sessionId, requestId, text: input.content, previewContext: reference },
    async () => hub
  );
  assert(replay.ok && !replay.created);
  assert.deepEqual(replay.previewContext, reference);
  count();
  const legacy = await rpc<{ ok: boolean }>('neo.message.send', {
    sessionId,
    requestId: '20000000-0000-4000-8000-000000000003',
    content: 'An ordinary unbound ask.',
  });
  assert(legacy.ok && !('previewContext' in legacy));
  Object.assign(evidence, {
    passed: true,
    exactSnapshot: true,
    serverDisplay: true,
    receiptAndMessageContext: true,
    sdkContextFact: true,
    bothReadProjections: true,
    revokedProjectionUnavailable: true,
    openingReauthorizes: true,
    retryNoDuplicate: true,
    restartPreserved: true,
    legacyCompatible: true,
    sourcePathsOmitted: true,
    webClientContext: true,
    webProjectionContext: true,
  });
} finally {
  await stop();
  evidence.ownedResourcesStopped = true;
  writeFileSync(join(run, 'evidence/preview-context.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence));
