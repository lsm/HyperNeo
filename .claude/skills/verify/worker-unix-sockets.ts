import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { codexWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { neoDerivedId } from '../../../packages/daemon/src/lib/neo/derived-id.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const signingSocket = join(run, 'signing.sock');
writeFileSync(join(run, 'home/.gitconfig'), '[gpg]\nformat = ssh\n[gpg "ssh"]\nprogram = synthetic-signing-program\n');
mkdirSync(join(run, 'home/.ssh'), { recursive: true });
writeFileSync(join(run, 'home/.ssh/config'), `Host *\n IdentityAgent ${signingSocket}\n`);
const report: Record<string, unknown> = {};
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let transport: WebSocketClientTransport | undefined;
try {
  for (let restart = 0; restart < 2; restart++) {
    app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    assert.notEqual(app.server.port, 8399);
    const hub = new MessageHub({ defaultSessionId: 'global' });
    transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws` });
    hub.registerTransport(transport);
    await transport.connect();
    const root = await hub.request<{ sessionId: string }>('operation.invoke', { name: 'neo.open', input: {} });
    const registry = app.sessionManager.getOperationRegistry();
    const store = new NeoAskTodoRepository(app.db.getDatabase());
    const startupId = neoDerivedId(`worker-socket:${signingSocket}`);
    for (let retry = 0; retry < 40 && !store.getQuestion(startupId); retry++) await new Promise((done) => setTimeout(done, 25));
    assert(store.getQuestion(startupId), 'startup discovers synthetic IdentityAgent');
    report.startupCard = startupId;
    const caller = { source: 'mcp' as const, role: 'neo' as const, sessionId: root.sessionId };
    const worker = { source: 'mcp' as const, role: 'direct_task_worker' as const, sessionId: 'synthetic-worker' };
    const refused = await invokeOperation(registry, 'neo.workerSocket.ask', { socket: join(run, 'worker-request.sock') }, worker);
    assert.deepEqual((refused as { value: unknown }).value, { ok: false, reason: 'This operation belongs to Neo.' });
    const allowed = join(run, 'agent.sock');
    const denied = join(run, 'db.sock');
    for (const [socket, answer] of [[allowed, 'yes'], [denied, 'no']] as const) {
      const asked = await invokeOperation(registry, 'neo.workerSocket.ask', { socket }, caller);
      assert.equal(asked.kind, 'completed');
      const card = (asked as { value: { id: string; state: string } }).value;
      const again = await invokeOperation(registry, 'neo.workerSocket.ask', { socket }, caller);
      assert.equal((again as { value: { id: string } }).value.id, card.id);
      if (!restart) {
        await hub.request('operation.invoke', { name: 'neo.question.answer', input: { questionId: card.id, answer } });
      } else assert.equal(card.state, 'answered');
    }
    assert.deepEqual(app.settingsManager.getGlobalSettings().workerUnixSockets, [allowed]);
    const policy = codexWorkerSandbox(run);
    assert.equal(policy.config.features.network_proxy.unix_sockets[allowed], 'allow');
    assert.equal(policy.config.features.network_proxy.unix_sockets[denied], undefined);
    report[`restart${restart}`] = { allowed, denied, policy };
    if (restart) {
      await hub.request('settings.global.update', { updates: { workerUnixSockets: [] } });
      assert.deepEqual(codexWorkerSandbox(run).config.features.network_proxy.unix_sockets, {});
      const store = new NeoAskTodoRepository(app.db.getDatabase());
      assert.equal(store.requestWorkerSocket(root.sessionId, allowed)?.state, 'answered');
      report.removalAppliesToNextSession = true;
    }
    await transport.close();
    transport = undefined;
    await app.cleanup();
    app = undefined;
  }
  report.result = 'pass';
} catch (error) {
  report.result = 'fail';
  report.error = String(error);
  throw error;
} finally {
  await transport?.close();
  await app?.cleanup();
  writeFileSync(join(run, 'evidence/worker-unix-sockets.json'), JSON.stringify(report, null, 2));
}
