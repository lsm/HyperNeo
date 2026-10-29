import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import { getSDKProjectDir, getSDKSessionFilePath } from '../../../packages/daemon/src/lib/sdk-session-file-manager.ts';

const run = resolve(process.argv.at(-1)!);
const checkOnly = process.argv.includes('--check-only');
const cancel = checkOnly && process.argv.includes('--cancel');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const sdk = await import('../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
let releaseBusy = () => {}, stop = () => {};
const busy = new Promise<void>(done => { releaseBusy = done; });
const received: string[] = [], results: string[] = [];
const report: Record<string, unknown> = { scriptedSdk: true };
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...sdk, query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> | string }) => {
  let ended = false, notify = () => {};
  const inputs: string[] = [];
  const sdkId = crypto.randomUUID();
  stop = () => { ended = true; releaseBusy(); notify(); };
  return {
    async *[Symbol.asyncIterator]() {
      if (typeof prompt === 'string') { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic title' }] } }; return; }
      mkdirSync(getSDKProjectDir(join(run, 'workspace')), { recursive: true });
      const reader = (async () => {
        try { for await (const input of prompt) {
          const text = typeof input.message.content === 'string' ? input.message.content : JSON.stringify(input.message.content);
          writeFileSync(getSDKSessionFilePath(join(run, 'workspace'), sdkId), JSON.stringify({ ...input, type: 'user', parentUuid: null }) + '\n', { flag: 'a' });
          received.push(text); inputs.push(text); notify(); if (ended) break;
        } } catch (error) { if (!ended) throw error; }
      })();
      void reader.catch(() => {});
      yield { type: 'system', subtype: 'init', uuid: crypto.randomUUID(), session_id: sdkId, cwd: join(run, 'workspace'), model: 'claude-haiku-4-5-20251001', permissionMode: 'default', apiKeySource: 'user', claude_code_version: 'synthetic', tools: [], skills: [], plugins: [], mcp_servers: [], slash_commands: [], output_style: 'default' };
      while (!ended) {
        if (!inputs.length) { await new Promise<void>(done => { notify = done; }); continue; }
        const input = inputs.shift()!;
        if (input.includes('HOLD_CURRENT_TURN')) await busy;
        if (ended) break;
        const text = input.includes('HOLD_CURRENT_TURN') ? 'BUSY_TURN_FINISHED' : 'REMINDER_TURN_FINISHED';
        results.push(text);
        yield { type: 'result', subtype: 'success', uuid: crypto.randomUUID(), session_id: sdkId, parent_tool_use_id: null, is_error: false, result: text, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] };
      }
    }, close: () => stop(), interrupt: async () => stop(), supportedModels: async () => [], supportedCommands: async () => [], setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
  };
} }));
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('External HTTP disabled'); }) as typeof fetch;
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const { NeoRepository } = await import('../../../packages/daemon/src/storage/repositories/neo-repository.ts');
const { NeoAskTodoRepository } = await import('../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts');
const { neoStallReminderWrite } = await import('../../../packages/daemon/src/storage/repositories/neo-stall-reminder-write.ts');
const { MessageHub, WebSocketClientTransport } = await import('../../../packages/shared/src/mod.ts');
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const until = async (check: () => boolean | Promise<boolean>, label: string) => { const end = performance.now() + 15000; while (!await check()) { assert(performance.now() < end, label); await new Promise(done => setTimeout(done, 20)); } };
try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic only', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'synthetic-never-sent' } });
  const { sessionId } = await hub.request<{ sessionId: string }>('session.create', { workspacePath: join(run, 'workspace'), title: 'Synthetic Neo stall reader', config: { model: 'haiku', provider: 'anthropic' } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  const hour = 3_600_000, now = Date.now(), age = (checkOnly ? 24 : 2) * hour;
  store.openAsk({ id: 'busy', sessionId, projectId: null, originMessageId: null, title: 'Busy ask', request: 'Synthetic', createdAt: now - age });
  for (const id of ['stuck', 'other']) {
    store.addTodo(id, 'busy', { title: id, doneWhen: 'Observed', check: checkOnly && id === 'stuck' ? { pack: 'core', kind: 'evidence', params: { path: join(run, 'missing-evidence') } } : null, instruction: null, named: null }, now - age);
    store.commitState(id, id === 'stuck' ? checkOnly ? { state: 'todo' } : { state: 'blocked', blockedBy: 'stalled' } : { state: 'doing' }, now - age, { state: 'no_opinion' });
  }
  await hub.request('message.send', { sessionId, content: 'HOLD_CURRENT_TURN' });
  await until(() => received.some(text => text.includes('HOLD_CURRENT_TURN')), 'held turn starts');
  await app.db.gateway.run(neoStallReminderWrite, { now });
  const queued = () => app.db.getJobQueueRepo().getLatestByPayload('mailbox', { 'to.sessionId': sessionId });
  const marker = checkOnly ? 'has a check but no instruction or target' : 'reminder 2 of 3';
  if (!checkOnly) {
    await until(() => received.some(text => text.includes('reminder 1 of 3')), 'steer reaches the busy SDK input');
    const firstId=String(queued()!.payload.messageUuid);
    await until(() => app.db.getSDKMessageRepo().getDeliveryContent(sessionId, firstId)?.sendStatus === 'consumed', 'steer consumed');
    await app.db.gateway.run(neoStallReminderWrite, { now });
    await app.db.gateway.run(neoStallReminderWrite, { now: Date.now() + 2 * hour });
    assert.notEqual(String(queued()!.payload.messageUuid),firstId);
  }
  assert.equal(results.length,0);
  const deferred=queued()!,deferredId=String(deferred.payload.messageUuid);
  assert.equal(deferred.payload.deliveryMode,'defer');
  await until(() => app.db.getSDKMessageRepo().getDeliveryContent(sessionId,deferredId)?.sendStatus === 'deferred','queue materialized as deferred');
  assert(!received.some(text=>text.includes(marker)));
  report.whileBusy = { received: [...received], results: [...results], queueStatus: 'deferred' };
  if (cancel) {
    const { neoTodoRunnerWrites } = await import('../../../packages/daemon/src/storage/repositories/neo-todo-runner-state.ts');
    await app.db.gateway.run(neoTodoRunnerWrites, { method: 'recompute', args: ['stuck', store.getTodo('stuck')!.check, { state: 'blocked', blockedBy: 'held' }, Date.now(), { state: 'no_opinion' }] });
    report.afterHoldStatus = app.db.getSDKMessageRepo().getUserSendStatus(sessionId,deferredId);
  }
  releaseBusy();
  if (!cancel) {
    await until(() => received.some(text => text.includes(marker)), 'queue reaches a fresh turn after busy result');
    await until(() => results.filter(text => text === 'REMINDER_TURN_FINISHED').length >= (checkOnly ? 1 : 2), 'reminder turns finish');
  } else await until(() => results.includes('BUSY_TURN_FINISHED'), 'held turn finishes');
  assert.equal(results[0], 'BUSY_TURN_FINISHED');
  const agent = app.sessionManager.getSession(sessionId)!;
  await until(() => agent.getProcessingState().status === 'idle', 'last reminder settles idle');
  await agent.replayPendingMessagesForImmediateMode({ waitForPostSettlementFlush: true });
  report.afterRelease = { received, results };
  if (cancel) {
    await new Promise(done=>setTimeout(done,250));
    assert(!received.some(text=>text.includes(marker)),'a held todo must not reach the next SDK turn');
    assert.equal(app.db.getSDKMessageRepo().getUserSendStatus(sessionId,deferredId),'failed');
  }
  report.passed = true;
} catch (error) { report.error = String(error); throw error; }
finally { releaseBusy(); stop(); await transport.close(); await app.cleanup(); globalThis.fetch = network; report.resourcesClosed = true; writeFileSync(join(run, 'evidence/delivery.json'), JSON.stringify(report, null, 2)); }
