import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const config = { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true };
const app = await createDaemonApp({ config, verbose: false });
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const replies = [];
  const id = '00000000-0000-4000-8000-000000000001';
  for (const [name, input] of [
    ['neo.ask.search', { query: 'missing' }],
    ['neo.conversation.read', { conversationId: id }],
    ['neo.conversation.asks.read', { conversationId: id }],
    ['neo.conversation.image.read', { conversationId: id, imageId: '1:0' }],
    ['neo.draft.recover', { sessionId: `neo:${id}`, text: 'proof', base: null }],
    ['neo.message.send', { sessionId: `neo:${id}`, requestId: id, content: 'proof' }],
  ] as const) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
      env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
    });
    const result = JSON.parse(await new Response(child.stdout).text());
    assert.equal(await child.exited, 0);
    assert(!result.reply.error, JSON.stringify(result));
    replies.push(result.reply);
  }
  assert.equal(replies.length, 6);
  assert.equal(replies[1].reason, 'conversation_not_found');
  assert.equal(replies[2].reason, 'conversation_not_found');
  assert.equal(replies[3].reason, 'conversation_not_found');
  writeFileSync(join(run, 'evidence/replies.json'), JSON.stringify(replies, null, 2));
  console.log(`RPC replies: ${replies.length}`);
} finally {
  await app.cleanup();
}
