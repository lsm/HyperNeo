import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { Database } from '../../../packages/daemon/src/storage/database.ts';
import { createReactiveDatabase } from '../../../packages/daemon/src/storage/reactive-database.ts';
import { InternalEventBus } from '../../../packages/daemon/src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { MessageQueue } from '../../../packages/daemon/src/lib/agent/message-queue.ts';
import { QueryRunner } from '../../../packages/daemon/src/lib/agent/query-runner.ts';
import { createNeoPublicationOperation } from '../../../packages/daemon/src/lib/neo/publication-operation.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpServer } from '../../../packages/daemon/src/lib/operations/mcp-server.ts';

const DESKTOP = '**Claude Desktop 环境**：查清楚了，环境只能由你在 Desktop 里新建，我这边建不了。';
const QLARK = '**qlark 长听写开关**：按你说的做了，长听写现在默认关闭，设置里可以打开。';
const STEPS = [
  { requestId: 'bundled', shortText: 'environments can only be created by you in Desktop', fullText: `${DESKTOP}\n\n${QLARK}`, links: [] },
  { requestId: 'desktop', shortText: 'Claude Desktop 环境: only you can create environments', fullText: DESKTOP, links: [] },
  { requestId: 'qlark', shortText: 'qlark 长听写开关 is now off by default', fullText: QLARK, links: [] },
];

const run = resolve(process.argv[2] ?? '');
const port = Number(process.argv[3] ?? 9366);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(port > 0 && port !== 8399);
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['home', 'data', 'workspace']) mkdirSync(join(run, dir), { recursive: true });

const db = new Database(join(run, 'data/daemon.db'));
await db.initialize(createReactiveDatabase(db));
const conversation = '10000000-0000-4000-8000-000000000009';
const root = `neo:${conversation}`;
const now = new Date().toISOString();
await db.createSession({
  id: root, title: 'Synthetic', workspacePath: join(run, 'workspace'), createdAt: now, lastActiveAt: now, status: 'active',
  config: { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 1 },
  metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
});
const neo = createNeoService(db, { getSessionAsync: async () => undefined } as never, { event: () => {} } as never, new InternalEventBus());
neo.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
const queue = new MessageQueue();
queue.start();
const runner = new QueryRunner({
  session: { id: root }, db, messageQueue: queue, stateManager: { setProcessing: async () => {} }, logger: { debug: () => {} },
  firstMessageReceived: true,
} as never);
db.getSDKMessageRepo().saveSDKMessage(root, {
  type: 'user', uuid: 'todo-event', session_id: root, parent_tool_use_id: null, inputKind: 'system',
  message: { role: 'user', content: [{ type: 'text', text: 'Synthetic todo progress' }] },
} as never);
void queue.enqueueWithId('todo-event', 'Synthetic todo progress', false, { durable: true }).catch(() => {});

let step = 0;
const receipts: string[] = [];
const registry = () => createOperationRegistry([createNeoPublicationOperation(neo.publish)]);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    if (!request.url.includes('/v1/messages')) return new Response('{}');
    const body = (await request.json()) as { messages: { content: unknown }[] };
    for (const message of body.messages ?? [])
      if (Array.isArray(message.content))
        for (const block of message.content)
          if (block.type === 'tool_result') receipts[Number(block.tool_use_id.split('-').at(-1))] = JSON.stringify(block.content);
    const command = STEPS[step];
    const id = `publish-${step++}`;
    const usage = { input_tokens: 20, output_tokens: 20 };
    const events = [
      ['message_start', { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: command ? { type: 'tool_use', id, name: 'mcp__hyperneo-operations__invoke', input: {} } : { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: command ? { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'neo.publication.publish', input: command }) } : { type: 'text_delta', text: 'Done.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: command ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});

const stream = query({
  prompt: runner.createMessageGeneratorWrapper(1),
  options: {
    cwd: join(run, 'workspace'), executable: 'bun', pathToClaudeCodeExecutable: resolveSDKCliPath(), model: 'claude-sonnet-4-20250514',
    tools: [], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [],
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-devproxy-test-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    mcpServers: { 'hyperneo-operations': createOperationMcpServer(registry, () => ({ sessionId: root, role: 'neo' })) },
    stderr: (data) => writeFileSync(join(run, 'sdk-stderr.log'), data, { flag: 'a' }),
    maxTurns: 8,
  },
});
const watchdog = setTimeout(() => {
  stream.close();
}, 30000);
try {
  for await (const event of stream) {
    if (event.type === 'result') break;
  }
  const published = (neo.publications.list(conversation) ?? []).map(({ shortText, fullText }) => ({ shortText, fullText }));
  writeFileSync(join(run, 'observed.json'), JSON.stringify({ receipts, published }, null, 2));
  assert.match(JSON.parse(receipts[0] ?? '[]')[0]?.text ?? '', /"accepted"\s*:\s*true/);
  assert.deepEqual(published.map((p) => p.fullText), [`${DESKTOP}\n\n${QLARK}`, DESKTOP, QLARK]);
  writeFileSync(join(run, 'evidence.json'), JSON.stringify({ actualSdkMcp: true, bundledAccepted: true, receipt: receipts[0], published }, null, 2));
  console.log(join(run, 'evidence.json'));
} finally {
  clearTimeout(watchdog);
  queue.clear();
  queue.stop();
  stream.close();
  await server.stop(true);
  await neo.dispose();
  db.close();
}
