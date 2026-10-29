import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, MessageHubRouter } from '../../../packages/shared/src/mod.ts';
import { query, createSdkMcpServer, tool } from '../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { resolveSDKCliPath } from '../../../packages/daemon/src/lib/agent/sdk-cli-resolver.ts';
import { Database } from '../../../packages/daemon/src/storage/database.ts';
import { createReactiveDatabase } from '../../../packages/daemon/src/storage/reactive-database.ts';
import { InternalEventBus } from '../../../packages/daemon/src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createNeoPublicationOperation } from '../../../packages/daemon/src/lib/neo/publication-operation.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpHandler, OperationMcpInvocationSchema } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createDiscoveryOperations } from '../../../packages/daemon/src/lib/operations/discovery.ts';
import { NEO_GOAL_CYCLE, NEO_ROOT_TURN_END } from '../../../packages/prompts/src/mod.ts';

const run = resolve(process.argv[3] ?? '');
const verify = process.argv[2] === 'verify';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const dir of ['workspace', 'data', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
const db = new Database(join(run, 'data/daemon.db'));
await db.initialize(createReactiveDatabase(db));
const conversation = '10000000-0000-4000-8000-000000000009';
const root = `neo:${conversation}`;
const now = new Date().toISOString();
await db.createSession({
  id: root, title: 'Synthetic delivery', workspacePath: join(run, 'workspace'), createdAt: now,
  lastActiveAt: now, status: 'active', config: { model: 'claude-sonnet-4-20250514' },
  metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
});
const hub = new MessageHub();
const router = new MessageHubRouter({ logger: { log() {}, warn() {}, error() {} } });
hub.registerRouter(router);
const delivered: unknown[] = [];
router.registerConnection({ id: 'synthetic-listener', isOpen: () => true,
  send: (data) => delivered.push(JSON.parse(data)),
});
const neo = createNeoService(db, { getSessionAsync: async () => undefined } as never, hub, new InternalEventBus());
neo.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
const listen = neo.speech.operations.find((operation) => operation.name === 'neo.speech.listen')!;
await listen.execute({ sessionId: root, enabled: true }, { source: 'rpc', principal: 'local', clientId: 'synthetic-listener' });
const registry = () => createOperationRegistry([
  createNeoPublicationOperation(neo.publish), ...neo.speech.operations, ...createDiscoveryOperations(registry),
]);
const handler = createOperationMcpHandler(registry, () => ({ sessionId: root, role: 'neo' }));
const observed: unknown[] = [];
try {
  for (const scenario of ['speech', 'publication', 'ordinary', 'transcript', 'scheduled-wake', 'forced-end-control']) {
    let requests = 0;
    let nudges = 0;
    let receivedGuidance: string | undefined;
    const receipts: unknown[] = [];
    const operation = scenario === 'speech' || scenario === 'forced-end-control' ? 'neo.speech.say'
      : scenario === 'ordinary' ? 'operations.describe' : 'neo.publication.publish';
    const input = operation === 'neo.speech.say' ? { requestId: scenario, text: 'Synthetic spoken reply.' }
      : operation === 'operations.describe' ? { name: 'neo.publication.publish' }
      : { requestId: scenario, shortText: 'Synthetic visible reply.', fullText: 'Synthetic visible reply.', links: [] };
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (!request.url.includes('/v1/messages')) return new Response('{}');
      const body = await request.json() as { messages?: { content?: unknown }[] };
      if (request.url.includes('count_tokens')) return Response.json({ input_tokens: 20 });
      const nudged = JSON.stringify(body.messages).includes('Your previous response had no visible output');
      if (nudged) nudges++;
      for (const message of body.messages ?? []) if (Array.isArray(message.content))
        for (const block of message.content) if (block.type === 'tool_result')
          for (const part of block.content ?? []) if (part.text?.startsWith('{')) {
            const receipt = JSON.parse(part.text);
            receivedGuidance = receipt.guidance;
          }
      const first = requests++ === 0;
      const text = nudged ? 'Runtime demanded visible text.' : scenario === 'transcript' ? 'Requested transcript.' : scenario === 'scheduled-wake' ? 'Scheduled work is waiting on a fixture.' : '';
      const usage = { input_tokens: 20, output_tokens: 20 };
      const events = [
        ['message_start', { type: 'message_start', message: { id: `msg_${scenario}_${requests}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], stop_reason: null, stop_sequence: null, usage } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: first ? { type: 'tool_use', id: `tool_${scenario}`, name: 'mcp__hyperneo-operations__invoke', input: {} } : { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: first ? { type: 'input_json_delta', partial_json: JSON.stringify({ name: operation, input }) } : { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage }],
        ['message_stop', { type: 'message_stop' }],
      ];
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const stream = query({ prompt: scenario === 'transcript' ? 'Deliver this and give me a transcript.' : scenario === 'scheduled-wake' ? `${NEO_ROOT_TURN_END}\n\n${NEO_GOAL_CYCLE}\n\nSynthetic scheduled goal wake: goalId=fixture; runId=fixture-run.` : 'Synthetic delivery probe.', options: {
      cwd: join(run, 'workspace'), pathToClaudeCodeExecutable: resolveSDKCliPath(), model: 'claude-sonnet-4-20250514',
      tools: [], permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: [],
      env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: 'sk-devproxy-test-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      mcpServers: { 'hyperneo-operations': createSdkMcpServer({ name: 'hyperneo-operations', tools: [tool('invoke', 'Invoke a synthetic operation.', OperationMcpInvocationSchema.shape, async (args) => {
        const result = await handler(args);
        receipts.push(JSON.parse(result.content[0].text));
        return scenario === 'forced-end-control' ? { ...result, _meta: { 'claude/endTurn': true } } : result;
      })] }) },
      stderr: (data) => writeFileSync(join(run, 'evidence/sdk-stderr.log'), data, { flag: 'a' }), maxTurns: 5,
    } });
    const watchdog = setTimeout(() => stream.close(), 30000);
    let completed = false;
    let finalText: string | undefined;
    try {
      for await (const event of stream) if (event.type === 'result') {
        assert.equal(event.is_error, false, JSON.stringify(event));
        if ('result' in event) finalText = event.result;
        completed = true;
        break;
      }
    } finally { clearTimeout(watchdog); stream.close(); await server.stop(true); }
    observed.push({ scenario, operation, requests, nudges, receivedGuidance, receipts, finalText });
    writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ observed, delivered, publications: neo.publications.list(conversation) }, null, 2));
    assert(completed);
    assert.equal(nudges, ['transcript', 'scheduled-wake', 'forced-end-control'].includes(scenario) ? 0 : 1);
    if (scenario === 'scheduled-wake') assert.equal(finalText, 'Scheduled work is waiting on a fixture.');
    if (scenario === 'forced-end-control') assert.equal(requests, 1, 'endTurn also prevents continuing work');
    else if (scenario === 'ordinary') assert.equal(receivedGuidance, undefined);
    else if (verify) {
      assert.match(receivedGuidance ?? '', /no assistant text this turn except a requested transcript\/record or required scheduled-wake summary/);
      assert((receivedGuidance?.length ?? 0) < 130);
    }
  }
  assert.equal(neo.publications.list(conversation)?.length, 3);
  assert(delivered.some((message) => JSON.stringify(message).includes('Synthetic spoken reply.')));
  console.log('PASS: real SDK receives delivery reminders; external empty-response nudge and forced-end limitation reproduced.');
} finally { await neo.dispose(); hub.cleanup(); db.close(); }
