import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { FindWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import type { Result, WorkDelivery, WorkDetail, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { z } from 'zod';

const run = process.argv.at(-1)!;
const [mode, binary] = process.argv.slice(2, -1);
const initializeRequiresAuth = mode === 'start-init-auth';
const resumeFixture = mode === 'resume';
const healthyStart = mode === 'start' || resumeFixture;
const startFixture = healthyStart || initializeRequiresAuth;
assert(startFixture || ['fixture', 'absent', 'signed-out', 'start-signed-out'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const workspaceRoot = join(run, 'workspace');
const evidence = join(run, 'evidence');
mkdirSync(workspaceRoot);
mkdirSync(evidence);
const bin = join(run, 'home/.local/bin');
mkdirSync(bin, { recursive: true });
const executable = join(bin, 'agy');
const journal = join(evidence, 'requests.jsonl');
const release = join(run, 'release');
const releaseFollowUp = join(run, 'release-follow-up');
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
if (mode === 'signed-out' || mode === 'start-signed-out') {
  assert(isAbsolute(binary));
  symlinkSync(binary, executable);
}
if (startFixture) {
  writeFileSync(executable, `#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const discovery = !process.argv.includes('--sandbox');
assert.deepEqual(process.argv.slice(2), discovery
  ? ['acp', '--disable-telemetry'] : ['acp', '--sandbox', '--disable-telemetry']);
assert.equal(process.cwd(), discovery ? process.env.HOME : ${JSON.stringify(workspaceRoot)});
const sessionId = 'owned-1';
const emit = (message) => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\\n');
const note = (id, text) => emit({method:'session/update',params:{sessionId:id,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
let promptId;
let resumed = false;
for await (const line of createInterface({input: process.stdin})) {
  const {id, method, params, result} = JSON.parse(line);
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify({method, params, result}) + '\\n');
  if (method === 'initialize') {
    emit(${initializeRequiresAuth}
      ? {id,error:{code:-32000,message:'Authentication required'}}
      : {id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:{},close:{},resume:{}}}}});
  }
  else if (method === 'session/list') emit({id,result:{sessions:[
    {sessionId,cwd:process.cwd(),title:'Owned fixture'},
    {sessionId:'foreign',cwd:process.cwd(),title:'External fixture'},
  ]}});
  else if (method === 'session/new') {
    assert.deepEqual(params,{cwd:${JSON.stringify(workspaceRoot)},mcpServers:[]});
    emit({id,result:{sessionId}});
  } else if (method === 'session/resume') {
    assert.deepEqual(params,{sessionId,cwd:${JSON.stringify(workspaceRoot)},mcpServers:[]});
    resumed = true;
    note(sessionId,'Replayed history');
    emit({id,result:{}});
  } else if (method === 'session/close') {
    assert.deepEqual(params,{sessionId});
    emit({id,result:{}});
  } else if (method === 'session/prompt') {
    assert.deepEqual(params,{sessionId,prompt:[{type:'text',text:resumed ? 'Continue the greeting.' : 'Reply with a greeting.'}]});
    promptId = id;
    emit({id:'permission-1',method:'session/request_permission',params:{sessionId,options:[],toolCall:{toolCallId:'tool'}}});
  } else {
    assert.equal(id,'permission-1');
    assert.deepEqual(result,{outcome:{outcome:'cancelled'}});
    const release = resumed ? ${JSON.stringify(releaseFollowUp)} : ${JSON.stringify(release)};
    while (!existsSync(release)) await Bun.sleep(25);
    note('other-session','Wrong session');
    note(sessionId,resumed ? 'Hello again' : 'Hello');
    emit({id:promptId,result:{stopReason:'end_turn'}});
  }
}
`, { mode: 0o700 });
}
if (mode === 'fixture') {
  process.env.HTTPS_PROXY = 'http://proxy.example.test:8080';
  process.env.ANTIGRAVITY_FIXTURE_PARENT_ONLY = 'parent';
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['acp', '--disable-telemetry']);
for await (const line of createInterface({ input: process.stdin })) {
  const {id, method, params} = JSON.parse(line);
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify({method, params}) + '\\n');
  if (method === 'initialize') await Bun.sleep(2_500);
  const cwd = ${JSON.stringify(workspaceRoot)};
  const result = method === 'initialize'
    ? {protocolVersion: 1, agentCapabilities: {sessionCapabilities: {list: {}}}}
    : params.cursor === 'next'
      ? {sessions: [{sessionId: 'agy-b', title: 'Find this session', cwd, updatedAt: '2026-08-05T00:00:00Z'}]}
      : {sessions: [{sessionId: 'agy-a', title: 'First session', cwd}], nextCursor: 'next'};
  assert(['initialize', 'session/list'].includes(method));
  assert.equal(process.env.HTTPS_PROXY, 'http://proxy.example.test:8080');
  assert.equal(process.env.ANTIGRAVITY_FIXTURE_PARENT_ONLY, undefined);
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id, result}) + '\\n');
}
`, { mode: 0o700 });
}

const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
let closed = Promise.resolve();
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: (url) => {
    const socket = createLocalSocket(url);
    closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    return socket;
  },
});
hub.registerTransport(transport);
const results: Record<string, unknown> = { mode };
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  const adapter = 'antigravity-cli';
  const catalog = await hub.request<{ ok: boolean; value: { id: string; capabilities: string[] }[] }>(
    'operation.invoke', { name: 'work.adapters', input: {} }
  );
  assert(catalog.ok);
  const registered = catalog.value.find((entry) => entry.id === adapter);
  results.catalog = registered ?? null;
  if (mode === 'absent') assert.equal(registered, undefined);
  else assert.deepEqual(registered?.capabilities, ['find', 'start', 'status', 'send']);

  let operations = 1;
  if (startFixture || mode === 'start-signed-out') {
    const input = {
      adapter,
      place: { machine: hostname(), folder: workspaceRoot, name: 'Fixture workspace' },
      title: 'Fixture work',
      message: 'Reply with a greeting.',
    };
    const rpc = <T>(name: string, input: object) => {
      operations += 1;
      return hub.request<T>('operation.invoke', { name, input });
    };
    if (healthyStart) {
      const refused = await rpc<Result<WorkStarted>>('work.start', { ...input, model: 'unsupported' });
      assert(!refused.ok && refused.notSent && refused.reason === 'unsupported_model');
      assert(!existsSync(journal));
    }
    const started = await rpc<Result<WorkStarted>>('work.start', input);
    results.started = started;
    if (!healthyStart) {
      assert(!started.ok && started.notSent && started.reason === 'unreachable');
      assert.equal(started.detail, 'Sign in to Antigravity CLI before starting a session.');
      if (initializeRequiresAuth) {
        const requests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(requests.map((request) => request.method), ['initialize']);
      }
    } else {
      assert(started.ok);
      assert.equal(started.value.status, 'running');
      assert.deepEqual(started.value.ref, { adapter, id: 'owned-1' });
      const snapshot = () => rpc<Result<WorkDetail>>('work.status', { ref: started.value.ref });
      const active = await snapshot();
      assert(active.ok && active.value.status === 'running');
      const send = (id: string) => rpc<Result<WorkDelivery>>('work.send', {
        ref: { adapter, id },
        message: 'Continue the greeting.',
      });
      if (resumeFixture) {
        const busy = await send(started.value.ref.id);
        assert(!busy.ok && busy.reason === 'busy' && busy.notSent, JSON.stringify(busy));
      }
      assert(!((await rpc<Result<WorkDetail>>('work.status', { ref: { adapter, id: 'foreign' } })).ok));
      writeFileSync(release, '');
      const deadline = Date.now() + 5_000;
      let settled = await snapshot();
      while (settled.ok && settled.value.status === 'running' && Date.now() < deadline) {
        await Bun.sleep(25);
        settled = await snapshot();
      }
      assert(settled.ok && settled.value.status === 'done');
      assert.equal(settled.value.lastReply, 'Hello');
      assert.deepEqual(settled.value.turnEnds?.map((turn) => turn.message), ['Hello']);
      results.settled = settled;
      const requests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(requests.map((request) => request.method), ['initialize', 'session/new', 'session/prompt', undefined, 'session/close']);
      assert.deepEqual(requests[3].result, { outcome: { outcome: 'cancelled' } });
      const find = async (folder?: string) => (await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', {
        adapters: [adapter], localOnly: true, ...(folder ? { folder } : {}),
      })).places.flatMap((place) => place.work);
      const scoped = await find(workspaceRoot);
      assert.deepEqual(scoped.map((item) => [item.ref.id, item.place.folder]), [['owned-1', workspaceRoot]]);
      const wrongFolder = await find(join(run, 'home'));
      assert.equal(wrongFolder.length, 0);
      const foreign = (await find()).find((item) => item.ref.id === 'foreign');
      assert(foreign);
      assert.equal(foreign.place.folder, undefined);
      if (resumeFixture) {
        const refused = await send(foreign.ref.id);
        assert(!refused.ok && refused.reason === 'not_started_by_us' && refused.notSent);
        const [first, second] = await Promise.all([
          send(started.value.ref.id),
          send(started.value.ref.id),
        ]);
        const [sent, competing] = first.ok ? [first, second] : [second, first];
        assert(sent.ok && !sent.value.delivered && sent.value.unconfirmed && sent.value.receipt, JSON.stringify(sent));
        assert(!competing.ok && competing.reason === 'busy' && competing.notSent);
        const readFollowUp = () => rpc<Result<WorkDetail>>('work.status', {
          ref: started.value.ref,
          receipt: sent.value.receipt,
        });
        const activeFollowUp = await readFollowUp();
        assert(activeFollowUp.ok && activeFollowUp.value.status === 'running');
        assert.equal(activeFollowUp.value.inputEvidence?.state, 'pending');
        const busy = await send(started.value.ref.id);
        assert(!busy.ok && busy.reason === 'busy' && busy.notSent);
        writeFileSync(releaseFollowUp, '');
        const followUpDeadline = Date.now() + 5_000;
        let followUp = await readFollowUp();
        while (followUp.ok && followUp.value.status === 'running' && Date.now() < followUpDeadline) {
          await Bun.sleep(25);
          followUp = await readFollowUp();
        }
        assert(followUp.ok && followUp.value.status === 'done');
        assert.equal(followUp.value.lastReply, 'Hello again');
        const input = followUp.value.inputEvidence;
        assert(input?.state === 'observed');
        assert.deepEqual(input.receipt, sent.value.receipt);
        assert.deepEqual(input.exchange.map(({ role, text }) => [role, text]), [
          ['user', 'Continue the greeting.'], ['agent', 'Hello again'],
        ]);
        const resumedRequests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(resumedRequests.map(({ method }) => method).slice(-5), [
          'initialize', 'session/resume', 'session/prompt', undefined, 'session/close',
        ]);
        results.resumed = followUp;
      }
    }
  } else if (mode !== 'absent') {
    operations += 1;
    const found = await hub.request<z.infer<typeof FindWorkResultSchema>>('operation.invoke', {
      name: 'work.find', input: { adapters: [adapter], text: 'Find this session', folder: workspaceRoot, limit: 1, localOnly: true },
    });
    results.found = found;
    if (mode === 'signed-out') {
      assert.equal(found.places.flatMap((place) => place.work).length, 0);
      assert.deepEqual(found.unreachable, [{ source: adapter, reason: 'Sign in to Antigravity CLI before listing its sessions.' }]);
    } else {
      assert.deepEqual(found.unreachable, []);
      const work = found.places.flatMap((place) => place.work);
      assert.equal(work.length, 1);
      assert.deepEqual(work[0].ref, { id: 'agy-b', adapter });
      assert.equal(work[0].title, 'Find this session');
      assert.equal(work[0].place.folder, workspaceRoot);
      const requests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(requests.map((request) => request.method), ['initialize', 'session/list', 'session/list']);
      assert.deepEqual(requests[2].params, { cwd: workspaceRoot, cursor: 'next' });
      results.requests = requests.length;
    }
  }
  results.passed = true;
  console.log(JSON.stringify({ mode, passed: true, operations }));
} finally {
  await transport.close();
  await closed;
  hub.cleanup();
  await app.cleanup();
  writeFileSync(join(evidence, 'antigravity-find.json'), JSON.stringify(results, null, 2));
}
