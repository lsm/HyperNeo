import { strict as assert } from 'node:assert';
import type { CopilotClient } from '@github/copilot-sdk';
import { startEmbeddedServer } from '../../../packages/daemon/src/lib/providers/anthropic-copilot/server.ts';

assert.equal(process.env.NODE_ENV, 'test');
const sent: Array<{ prompt: string; attachments?: unknown[] }> = [];
const vision = (max: number) => ({
  supports: { vision: true },
  limits: { vision: { supported_media_types: ['image/png'], max_prompt_images: max, max_prompt_image_size: 100 } },
});
const client = {
  async listModels() {
    return [
      { id: 'limit-one', name: 'limit-one', capabilities: vision(1) },
      { id: 'no-vision', name: 'no-vision', capabilities: { supports: { vision: false }, limits: {} } },
    ];
  },
  async createSession() {
    const subs: Array<(e: { type: string; data: unknown }) => void> = [];
    const emit = (type: string, data: unknown = {}) => subs.forEach((h) => h({ type, data }));
    return {
      on: (h: (e: { type: string; data: unknown }) => void) => (subs.push(h), () => {}),
      async send(opts: { prompt: string; attachments?: unknown[] }) {
        sent.push(opts);
        queueMicrotask(() => {
          emit('assistant.message_delta', { deltaContent: 'summary' });
          emit('assistant.message', { content: 'summary' });
          emit('session.idle');
        });
        return 'ok';
      },
      async abort() {},
      async disconnect() {},
    };
  },
} as unknown as CopilotClient;

const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const compaction = (model: string) => ({
  model,
  max_tokens: 100,
  stream: false,
  system: 'Summarize the conversation so far.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'look at this' }, image('QUFB')] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'and this' }, image('QkJC')] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'Create a summary of this conversation.' }, image('Q0ND')] },
  ],
});

const server = await startEmbeddedServer(client, process.cwd());
try {
  const post = async (body: object) => {
    const r = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.text() };
  };
  const ok = await post(compaction('limit-one'));
  const last = sent.at(-1);
  const placeholders = last?.prompt.split('[earlier image omitted: model accepts at most 1 images per request]').length;
  console.log(JSON.stringify({ limitOne: { status: ok.status, attachments: last?.attachments, placeholders: (placeholders ?? 1) - 1 } }));
  assert.equal(ok.status, 200, ok.body);
  assert.deepEqual(last?.attachments, [{ type: 'blob', data: 'Q0ND', mimeType: 'image/png' }]);
  assert.equal(placeholders, 3);

  const refused = await post(compaction('no-vision'));
  console.log(JSON.stringify({ noVision: refused }));
  assert.equal(refused.status, 400);
  assert.match(refused.body, /does not support vision/);
  console.log('PASS');
} finally {
  await server.stop();
}
