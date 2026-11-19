import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { JsonRpcNotification } from '@hyperneo/shared';
import {
  compactCodexThread,
  startCodexBootstrapServer,
} from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';

const [, , root, codex] = process.argv;
assert(root && codex);
const run = resolve(root);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.CODEX_HOME, join(run, 'codex'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const cwd = join(run, 'workspace');
mkdirSync(cwd);
mkdirSync(process.env.CODEX_HOME);
let requests = 0;
const model = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    assert.equal(new URL(request.url).pathname, '/v1/responses');
    const n = ++requests;
    const item = {
      id: `msg_${n}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Synthetic worker context.', annotations: [] }],
    };
    const response = {
      id: `resp_${n}`,
      object: 'response',
      status: 'completed',
      model: 'synthetic',
      output: [item],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    return new Response(
      events.map((event, i) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number: i, ...event })}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  },
});
writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), `model = "synthetic"
model_provider = "synthetic"
approval_policy = "never"
[model_providers.synthetic]
name = "Synthetic"
base_url = "http://127.0.0.1:${model.port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);

const events: JsonRpcNotification[] = [];
const firstTurn = Promise.withResolvers<string>();
const timer = setTimeout(() => firstTurn.resolve('timeout'), 15_000);
let server: Awaited<ReturnType<typeof startCodexBootstrapServer>> | undefined;
try {
  server = await startCodexBootstrapServer(codex, (message) => {
    events.push(message);
    if (message.method === 'turn/completed')
      firstTurn.resolve((message.params as { turn: { status: string } }).turn.status);
  });
  const { thread } = (await server.call('thread/start', { cwd })) as { thread: { id: string } };
  await server.call('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Reply with a short sentence.', text_elements: [] }],
  });
  assert.equal(await firstTurn.promise, 'completed');
  const baseline = requests;
  const turnEvents = events.length;
  const compacted = await compactCodexThread(server, thread.id);
  const compactEvents = events.slice(turnEvents).map((event) => ({
    method: event.method,
    itemType: (event.params as { item?: { type?: string } } | undefined)?.item?.type,
    error: event.method === 'error' ? event.params : undefined,
  }));
  assert.equal(compacted, true, JSON.stringify({ requests: requests - baseline, compactEvents }));
  assert.ok(requests > baseline, 'The live app-server did not request compaction');
  const confirmations = events.slice(turnEvents).filter((event) => {
    const params = event.params as { threadId?: string; item?: { type?: string } };
    return params.threadId === thread.id && (event.method === 'thread/compacted' ||
      (event.method === 'item/completed' && params.item?.type === 'contextCompaction'));
  });
  assert.ok(confirmations.length > 0);
  console.log(`PASS: live app-server emitted ${confirmations.map((event) => event.method).join(', ')} after ${requests - baseline} compaction model request(s).`);
} finally {
  clearTimeout(timer);
  await server?.close();
  model.stop(true);
}
