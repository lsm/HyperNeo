import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAnthropicMessagesBridgeServer } from '../../../packages/daemon/src/lib/providers/anthropic-messages-bridge/server.ts';
import { createOpenAIChatBridgeServer } from '../../../packages/daemon/src/lib/providers/openai-chat-bridge/server.ts';

type Message = { role: string; content: unknown[] };
type UpstreamBody = { messages: { role: string; content: unknown; tool_call_id?: string }[] };
const prefix = 'mcp__hyperneo-operations__';
const call = (id: string, name: string, input = {}) => ({
  type: 'tool_use',
  id,
  name: prefix + name,
  input,
});
const result = (id: string, status: { ok: boolean; reason?: string } = { ok: true }, error = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  ...(error ? { is_error: true } : {}),
  content: [
    { type: 'text', text: JSON.stringify(status) },
    { type: 'text', text: 'AX window and handle '.repeat(100) },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
  ],
});
const assistant = (...content: unknown[]) => ({ role: 'assistant', content });
const user = (...content: unknown[]) => ({ role: 'user', content });
const step = (calls: unknown[], results: unknown[]) => [assistant(...calls), user(...results)];

const earlier = [
  ...step([call('launch', 'launch_app', { bundle_id: 'com.example.App' })], [result('launch')]),
  ...step([call('list', 'list_windows')], [result('list')]),
  ...step(
    [call('drag', 'drag', { to_y: 8, from_y: 0, from_x: 5, to_x: 7 })],
    [result('drag')]
  ),
  ...step([call('zoom', 'invoke', { name: 'desktop.call', input: { tool: 'zoom', args: { x2: 4, y2: 3, x1: 2, y1: 1 } } })], [result('zoom')]),
  ...step(
    [call('type', 'type_text', { window_id: 2, pid: 1, text: 'payload' })],
    [result('type')]
  ),
];
const failure = result('fail', { ok: false, reason: 'stale_target' }, true);
const laterFailure = result('fail2', { ok: false, reason: 'busy' });
const extraFailure = result('fail3', { ok: true, reason: 'driver_error' }, true);
const read = result('read');
const nonDesktop = result('other');
const success = result('click');
const before = [
  ...earlier,
  ...step(
    [call('fail', 'click', { element_token: 's00000000:1' })],
    [failure]
  ),
  ...step(
    [call('read', 'get_window_state', { pid: 1, window_id: 2 }), call('other', 'invoke', { name: 'message.send' })],
    [read, nonDesktop]
  ),
  assistant({ type: 'text', text: 'Carry forward the exact receipt AB0123.' }),
  user({ type: 'text', text: 'Keep going.' }),
];
const failures = [
  ...before,
  ...step(
    [call('fail2', 'click', { y: 10, x: 0 }), call('fail3', 'click')],
    [laterFailure, extraFailure]
  ),
];
const after = [...before, ...step([call('click', 'click', { x: 0, y: 4 })], [success])];

async function verify(bridge: 'messages' | 'chat', collapseDesktopObservations: boolean) {
  const captured: UpstreamBody[] = [];
  const options = {
    baseUrl: 'http://127.0.0.1:1',
    collapseDesktopObservations: () => collapseDesktopObservations,
    toolUseSupported: true,
    visionSupported: true,
    fetchImpl: Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push(await new Response(init?.body).json() as UpstreamBody);
      if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 1 });
      const stream = bridge === 'messages'
        ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }, { preconnect: fetch.preconnect }),
  };
  const upstream = bridge === 'messages'
    ? await createAnthropicMessagesBridgeServer(options)
    : await createOpenAIChatBridgeServer(options);
  try {
    async function post(messages: Message[], path = '') {
      const response = await fetch(`http://127.0.0.1:${upstream.port}/v1/messages${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'synthetic', stream: true, max_tokens: 20, messages }),
      });
      assert.equal(response.status, 200);
      if (path && bridge === 'chat') {
        return ((await response.json()) as { input_tokens: number }).input_tokens;
      }
      await response.text();
      return captured.at(-1)!.messages;
    }
    const full = (observation: typeof read) => bridge === 'messages'
      ? observation.content
      : observation.content.map(block => block.type === 'text' ? block.text : '[image]').join('\n');
    const readResult = (messages: UpstreamBody['messages'] | number, id: string) => {
      assert(Array.isArray(messages));
      if (bridge === 'chat') return messages.find(message => message.tool_call_id === id)?.content;
      const block = messages
        .flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find((candidate: typeof read) => candidate.tool_use_id === id) as typeof read | undefined;
      return block?.content;
    };
    const original = JSON.stringify([before, after, failures]);
    const first = await post(before);
    assert.deepEqual(readResult(first, 'launch'), collapseDesktopObservations ? 'launch_app bundle_id=com.example.App ok' : full(result('launch')));
    assert.deepEqual(readResult(first, 'read'), full(read));
    assert.deepEqual(readResult(first, 'fail'), full(failure));
    assert.deepEqual(readResult(first, 'other'), full(nonDesktop));
    const next = await post(after);
    assert.deepEqual(readResult(next, 'click'), full(success));
    assert.deepEqual(readResult(next, 'fail'), collapseDesktopObservations ? 'click element_token=s00000000:1 failed stale_target' : full(failure));
    assert.deepEqual(readResult(next, 'read'), collapseDesktopObservations ? 'get_window_state pid=1 window_id=2 ok' : full(read));
    assert.deepEqual(readResult(next, 'other'), full(nonDesktop));
    assert(Array.isArray(next) && Array.isArray(first));
    assert.deepEqual(next.slice(0, earlier.length + 1), first.slice(0, earlier.length + 1));
    assert(JSON.stringify(next).includes('Carry forward the exact receipt AB0123.'));
    const newestFailures = await post(failures);
    assert.deepEqual(readResult(newestFailures, 'fail2'), full(laterFailure));
    assert.deepEqual(readResult(newestFailures, 'fail3'), full(extraFailure));
    assert.deepEqual(readResult(newestFailures, 'fail'), readResult(next, 'fail'));
    const latestRead = [...failures, ...step([call('read2', 'list_windows')], [result('read2')])];
    const afterFailures = await post(latestRead);
    assert.deepEqual(readResult(afterFailures, 'fail2'), collapseDesktopObservations ? 'click x=0 y=10 failed busy' : full(laterFailure));
    assert.deepEqual(readResult(afterFailures, 'fail3'), full(extraFailure));
    const unclassified = ['Desktop driver exited before reporting status', '{invalid', '{"reason":"busy"}'];
    const unknownActions = step(
      unclassified.map((_, index) => call(`unknown-${index}`, 'click', { x: index })),
      unclassified.map((content, index) => ({ ...result(`unknown-${index}`), content }))
    );
    const afterUnknown = await post([
      ...before,
      ...unknownActions,
      ...step([call('fresh-read', 'list_windows')], [result('fresh-read')]),
    ]);
    for (const [index, content] of unclassified.entries()) {
      assert.equal(readResult(afterUnknown, `unknown-${index}`), collapseDesktopObservations ? `click x=${index} unknown` : content);
    }
    assert.deepEqual(readResult(afterUnknown, 'fail'), full(failure));
    for (const [id, line] of [
      ['list', 'list_windows ok'],
      ['drag', 'drag from_x=5 from_y=0 to_x=7 to_y=8 ok'],
      ['zoom', 'zoom x1=2 y1=1 x2=4 y2=3 ok'],
      ['type', 'type_text pid=1 window_id=2 ok'],
    ]) {
      assert.deepEqual(readResult(next, id), collapseDesktopObservations ? line : full(result(id)));
    }
    assert.equal(JSON.stringify([before, after, failures]), original);
    const count = await post(after, '/count_tokens');
    if (bridge === 'messages') assert.deepEqual(count, next);
    return { bridge, collapseDesktopObservations, requests: captured.length, count };
  } finally {
    upstream.stop();
  }
}

const run = process.argv[2];
const off = await verify('chat', false);
const on = await verify('chat', true);
assert(typeof off.count === 'number' && typeof on.count === 'number' && on.count < off.count);
const results = [off, on, await verify('messages', false), await verify('messages', true)];
await mkdir(join(run, 'evidence'), { recursive: true });
await writeFile(join(run, 'evidence', 'desktop-observation-collapse.json'), JSON.stringify(results.map(({ count, ...result }) => ({ ...result, ...(typeof count === 'number' ? { inputTokens: count } : { forwardedMessages: count.length }) })), null, 2));
console.log(`desktop observation collapse PASS modes=${results.length} upstream_requests=${results.reduce((sum, result) => sum + result.requests, 0)} chat_tokens=${off.count}->${on.count}`);
