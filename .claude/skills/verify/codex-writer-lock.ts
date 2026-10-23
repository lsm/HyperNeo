import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startCodexBootstrapServer } from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.CODEX_HOME, join(run, 'codex'));
assert(!existsSync(join(run, 'codex/state_5.sqlite')));
const command = process.env.VERIFY_CODEX_CLI;
assert(command, 'Set VERIFY_CODEX_CLI to the installed Desktop-bundled Codex CLI');
mkdirSync(join(run, 'workspace'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const owner = await startCodexBootstrapServer(command);
let reader: Awaited<ReturnType<typeof startCodexBootstrapServer>> | undefined;
const observed: Record<string, unknown> = { startedAt: new Date().toISOString(), command };
try {
  reader = await startCodexBootstrapServer(command);
  const created = (await owner.call('thread/start', {
    cwd: join(run, 'workspace'),
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })) as { thread: { id: string; path: string } };
  const threadId = created.thread.id;
  observed.threadId = threadId;
  await owner.call('thread/inject_items', {
    threadId,
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic ownership proof. No model request.' }] }],
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(created.thread.path) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 20));
  assert(existsSync(created.thread.path), 'The synthetic thread must have persisted history');
  await assert.rejects(async () => {
    try {
      await reader!.call('thread/resume', { threadId, excludeTurns: true });
    } catch (error) {
      observed.conflict = String(error);
      throw error;
    }
  }, /already has an active writer/);
  await owner.close();
  observed.released = await reader.call('thread/resume', { threadId, excludeTurns: true });
  observed.pass = true;
} finally {
  await owner.close();
  await reader?.close();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
}
console.log(`Synthetic writer ownership PASS: ${run}/evidence/observed.json`);
