import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { gatewayFor } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import type { FindWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import type { ReadWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/read-operation.ts';
import type { Result, WorkDelivery, WorkDetail, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { queueNextTodo } from './worker-reuse-todo.ts';
import type { z } from 'zod';

const run = process.argv.at(-1)!;
const [mode, binary] = process.argv.slice(2, -1);
const initializeRequiresAuth = mode === 'start-init-auth';
const lateBatch = mode === 'resume-late-batch';
const lateClose = mode === 'resume-late-close';
const stopRace = mode === 'stop-race' || mode === 'stop-race-close-error';
const closeError = mode === 'stop-close-error' || mode === 'stop-race-close-error';
const holdClose = mode === 'stop-held-close';
const stopFixture = mode === 'stop' || stopRace || closeError || holdClose;
const steerWithoutReplay = mode === 'steer-without-replay';
const steerIdentical = mode === 'steer-identical';
const steerFixture = mode === 'steer' || steerWithoutReplay || steerIdentical;
const steerMessage = steerIdentical ? 'Reply with a greeting.' : 'Change the greeting.';
const resumeFixture = mode === 'resume' || lateBatch || lateClose || stopFixture;
const longHistory = mode === 'history-long';
const historyFixture = mode === 'history' || longHistory;
const compactUnconfirmed = mode === 'compact-unconfirmed';
const worktreeReplacement = mode === 'worktree-replacement';
const busyReplacement = mode === 'busy-replacement' || worktreeReplacement;
const compactFixture = mode === 'compact' || compactUnconfirmed || busyReplacement;
const configUnsupported = mode === 'config-unsupported';
const configUnconfirmed = mode === 'config-unconfirmed';
const configFixture = mode === 'config' || configUnsupported || configUnconfirmed;
const healthyStart = mode === 'start' || resumeFixture || historyFixture || compactFixture || configFixture || steerFixture;
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
const releaseClose = join(run, 'release-close');
const releaseCompaction = join(run, 'release-compaction');
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
if (process.argv[2] === '--version') {
  process.stdout.write('1.5.14\\n');
  process.exit(0);
}
if (process.argv[2] === '--sandbox') {
  const args = ['--sandbox','--conversation','owned-1','--settings','{"disableSlashCommands":false}','--print','/compact','--output-format','stream-json','--print-timeout','180s'];
  assert.deepEqual(process.argv.slice(2), args);
  assert.equal(process.cwd(), ${JSON.stringify(workspaceRoot)});
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify({method:'compact'}) + '\\n');
  while (!existsSync(${JSON.stringify(releaseCompaction)})) await Bun.sleep(25);
  const step = (conversation_id, step_index, step_type) => ({
    event:'step_update',step_update:{conversation_id,step_index,step_type,state:'DONE'},
  });
  for (const event of [
    step('owned-1',2,'user_input'),
    step('foreign',3,'checkpoint'),
    ...(${compactUnconfirmed} ? [] : [step('owned-1',4,'checkpoint')]),
    {event:'result',result:{conversation_id:'owned-1',status:'SUCCESS'}},
  ]) process.stdout.write(JSON.stringify(event) + '\\n');
  process.exit(0);
}
const discovery = !process.argv.includes('--sandbox');
assert.deepEqual(process.argv.slice(2), discovery
  ? ['acp', '--disable-telemetry'] : ['acp', '--sandbox', '--disable-telemetry']);
assert.equal(process.cwd(), discovery ? process.env.HOME : ${JSON.stringify(workspaceRoot)});
let sessionId = 'owned-1';
let replacement = false;
const emit = (...messages) => process.stdout.write(messages.map(message => JSON.stringify({jsonrpc: '2.0', ...message}) + '\\n').join(''));
const chunk = (id, text, role='agent') => ({method:'session/update',params:{sessionId:id,update:{sessionUpdate:role+'_message_chunk',content:{type:'text',text}}}});
const note = (id, text) => emit(chunk(id, text));
let promptId;
let resumed = false;
let model = 'model-default';
let effort = 'high';
const choices = (values) => values.map(value=>({value,name:value}));
const configOptions = () => [
  {
    id:'active-model',category:'model',type:'select',currentValue:model,
    options:[{group:'available',options:choices(['model-default','model-alt'])}],
  },
  {
    id:'reasoning',category:'thought_level',type:'select',currentValue:effort,
    options:choices(model === 'model-alt' ? ['low','high'] : ['medium','high']),
  },
];
for await (const line of createInterface({input: process.stdin})) {
  const {id, method, params, result} = JSON.parse(line);
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify({method, params, result}) + '\\n');
  if (method === 'initialize') {
    emit(${initializeRequiresAuth}
      ? {id,error:{code:-32000,message:'Authentication required'}}
      : {id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},close:{},resume:{}}}}});
  }
  else if (method === 'session/list') emit({id,result:{sessions:[
    {sessionId,cwd:process.cwd(),title:'Owned fixture'},
    {sessionId:'foreign',cwd:process.cwd(),title:'External fixture'},
  ]}});
  else if (method === 'session/new') {
    assert.deepEqual(params,{cwd:${JSON.stringify(workspaceRoot)},mcpServers:[]});
    if (${compactUnconfirmed || busyReplacement} && existsSync(${JSON.stringify(releaseCompaction)})) {
      sessionId = 'owned-2';
      replacement = true;
    }
    emit({id,result:{sessionId,configOptions:${configFixture} ? configOptions() : undefined}});
  } else if (method === 'session/set_config_option') {
    assert(${configFixture});
    assert.equal(params.sessionId,sessionId);
    if (params.configId === 'active-model') {
      assert.equal(params.value,'model-alt');
      model = params.value;
    } else {
      assert.equal(params.configId,'reasoning');
      assert.equal(model,'model-alt');
      assert.equal(params.value,'low');
      if (!${configUnconfirmed}) effort = params.value;
    }
    emit({id,result:{configOptions:configOptions()}});
  } else if (method === 'session/resume') {
    assert.deepEqual(params,{sessionId,cwd:${JSON.stringify(workspaceRoot)},mcpServers:[]});
    resumed = true;
    note(sessionId,'Replayed history');
    emit({id,result:{}});
  } else if (method === 'session/load') {
    assert.deepEqual(params,{sessionId,cwd:${JSON.stringify(workspaceRoot)},mcpServers:[]});
    if (${steerFixture}) {
      emit(
        chunk(sessionId,'Reply with a greeting.','user'),
        chunk(sessionId,'Original answer'),
        ...(${steerWithoutReplay} ? [] : [chunk(sessionId,'Change the greeting.','user'),chunk(sessionId,'New answer')]),
        {id,result:{}},
      );
      continue;
    }
    emit(
      chunk(sessionId,'Opening question','user'),
      chunk(sessionId,'First'), chunk(sessionId,' answer'),
      chunk('foreign','Wrong session'),
      chunk(sessionId,'Unanswered question','user'),
      chunk(sessionId,'Next question','user'),
      chunk(sessionId,${longHistory} ? 'x'.repeat(15999)+'😀tail' : 'Second answer'),
      {id,result:{}},
      chunk(sessionId,' Late replay'),
    );
  } else if (method === 'session/close') {
    assert.deepEqual(params,{sessionId});
    if (resumed && ${lateClose}) note(sessionId,' Late during close');
    if (resumed && ${holdClose}) {
      while (!existsSync(${JSON.stringify(releaseClose)})) await Bun.sleep(25);
    }
    if (resumed && ${closeError}) emit({id,error:{code:-32603,message:'Save failed'}});
    else emit({id,result:{}});
  } else if (method === 'session/prompt') {
    if (replacement) {
      assert.equal(params.sessionId, 'owned-2');
      assert(params.prompt[0].text.includes('Synthetic next todo of the same ask'));
      emit({id,result:{stopReason:'end_turn'}});
      continue;
    }
    if (${steerFixture}) {
      assert.equal(params.sessionId,sessionId);
      if (promptId === undefined) {
        promptId = id;
        note(sessionId, 'Original answer');
      } else {
        assert.deepEqual(params.prompt,[{type:'text',text:${JSON.stringify(steerMessage)}}]);
        emit({id:promptId,result:{stopReason:'end_turn'}},chunk(sessionId,'Late original text'));
        while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(25);
        emit(chunk(sessionId,'New answer'),{id,result:{stopReason:'end_turn'}});
      }
      continue;
    }
    if (${configFixture}) assert.deepEqual([model,effort],['model-alt','low']);
    assert.deepEqual(params,{sessionId,prompt:[{type:'text',text:resumed ? 'Continue the greeting.' : 'Reply with a greeting.'}]});
    promptId = id;
    emit({id:'permission-1',method:'session/request_permission',params:{sessionId,options:[],toolCall:{toolCallId:'tool'}}});
  } else if (method === 'session/cancel') {
    assert(resumed && ${stopFixture});
    assert.equal(id,undefined);
    assert.deepEqual(params,{sessionId});
    while (!existsSync(${JSON.stringify(releaseFollowUp)})) await Bun.sleep(25);
    if (${stopRace}) note(sessionId,'Hello again');
    emit({id:promptId,result:{stopReason:${JSON.stringify(stopRace ? 'end_turn' : 'cancelled')}}});
  } else {
    assert.equal(id,'permission-1');
    assert.deepEqual(result,{outcome:{outcome:'cancelled'}});
    if (resumed && ${stopFixture}) continue;
    const release = resumed ? ${JSON.stringify(releaseFollowUp)} : ${JSON.stringify(release)};
    while (!existsSync(release)) await Bun.sleep(25);
    note('other-session','Wrong session');
    note(sessionId,resumed ? 'Hello again' : 'Hello');
    const ended = {id:promptId,result:{stopReason:'end_turn'}};
    if (resumed && ${lateBatch}) emit(ended, chunk(sessionId,' Late prior turn'));
    else emit(ended);
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
  const catalog = await hub.request<{ ok: boolean; value: { id: string; capabilities: string[]; steerBehavior?: string; unsupportedCapabilities?: Record<string, string> }[] }>(
    'operation.invoke', { name: 'work.adapters', input: {} }
  );
  assert(catalog.ok);
  const registered = catalog.value.find((entry) => entry.id === adapter);
  results.catalog = registered ?? null;
  if (mode === 'absent') assert.equal(registered, undefined);
  else assert.deepEqual(registered?.capabilities, ['find', 'start', 'status', 'send', 'steer', 'stop']);

  let operations = 1;
  if (mode === 'fixture') {
    const unsupported = registered?.unsupportedCapabilities;
    assert.match(unsupported?.rename ?? '', /ACP.*\/resume.*F2/);
    assert.match(unsupported?.archive ?? '', /ACP.*archive/);
    const renamed = await hub.request<Result<{ renamed: boolean }>>('operation.invoke', {
      name: 'work.rename', input: { ref: { adapter, id: 'agy-b' }, title: 'Refused rename' },
    });
    operations += 1;
    assert(!renamed.ok && renamed.reason === 'not_supported');
    assert.equal(renamed.detail, unsupported?.rename);
    results.renameRefusal = renamed;
  }
  if (steerFixture) {
    assert.equal(registered?.steerBehavior, 'best_effort');
    const invoke = <T>(name: string, input: object) => {
      operations += 1;
      return hub.request<T>('operation.invoke', { name, input });
    };
    const started = await invoke<Result<WorkStarted>>('work.start', {
      adapter,
      place: { machine: hostname(), folder: workspaceRoot, name: 'Fixture workspace' },
      title: 'Steering fixture',
      message: 'Reply with a greeting.',
    });
    assert(started.ok, JSON.stringify(started));
    const { ref } = started.value;
    const steer = (target = ref) => invoke<Result<WorkDelivery>>('work.send', {
      ref: target, message: steerMessage, mode: 'steer',
    });
    const sent = await steer();
    assert(sent.ok && !sent.value.delivered && sent.value.unconfirmed && sent.value.receipt, JSON.stringify(sent));
    const receipt = sent.value.receipt;
    const snapshot = () => invoke<Result<WorkDetail>>('work.status', { ref, receipt });
    const pending = await snapshot();
    assert(pending.ok && pending.value.status === 'running' && pending.value.inputEvidence?.state === 'pending');
    const overlapping = await steer();
    assert(!overlapping.ok && overlapping.reason === 'busy' && overlapping.notSent);
    const foreign = await steer({ adapter, id: 'foreign' });
    assert(!foreign.ok && foreign.notSent);
    writeFileSync(release, '');
    const deadline = Date.now() + 5_000;
    let settled = await snapshot();
    while (settled.ok && settled.value.status === 'running' && Date.now() < deadline) {
      await Bun.sleep(25);
      settled = await snapshot();
    }
    assert(settled.ok && settled.value.status === 'done');
    const evidence = settled.value.inputEvidence;
    if (steerWithoutReplay || steerIdentical) {
      assert.equal(settled.value.lastReply, undefined);
      assert.equal(evidence?.state, 'unavailable');
    } else {
      assert.equal(settled.value.lastReply, 'New answer');
      assert(evidence?.state === 'observed');
      assert.deepEqual(evidence.exchange.map(({ role, text }) => [role, text]), [
        ['user', 'Change the greeting.'], ['agent', 'New answer'],
      ]);
    }
    const idle = await steer();
    assert(!idle.ok && idle.notSent);
    const requests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(requests.map(({ method }) => method), [
      'initialize', 'session/new', 'session/prompt', 'session/prompt', 'session/close',
      ...(steerIdentical ? [] : ['initialize', 'session/load']),
    ]);
    results.steered = settled;
  } else if (startFixture || mode === 'start-signed-out') {
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
    if (configFixture) {
      const { description } = await rpc<{ description: string }>('operations.describe', { name: 'work.start' });
      assert.match(description, /Antigravity CLI accepts model and effort on new sessions/);
      assert.match(description, /Antigravity CLI reports the confirmed model and effort/);
      results.startGuidance = 'Advertises Antigravity model and effort on new sessions';
    }
    if (healthyStart && !configFixture) {
      const refused = await rpc<Result<WorkStarted>>('work.start', { ...input, model: 'unsupported' });
      assert(!refused.ok && refused.notSent && refused.reason === 'unsupported_model');
      if (existsSync(journal)) {
        assert(!readFileSync(journal, 'utf8').includes('"session/prompt"'));
        writeFileSync(journal, '');
      }
    }
    const requested = configFixture
      ? { ...input, model: 'model-alt', effort: configUnsupported ? 'medium' : 'low' }
      : input;
    const started = await rpc<Result<WorkStarted>>('work.start', requested);
    results.started = started;
    if (configUnsupported || configUnconfirmed) {
      assert(!started.ok && started.notSent, JSON.stringify(started));
      assert.equal(started.reason, configUnsupported ? 'unsupported_effort' : 'not_delivered');
      const requests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(requests.map(({ method }) => method), [
        'initialize', 'session/new', 'session/set_config_option',
        ...(configUnconfirmed ? ['session/set_config_option'] : []), 'session/close',
      ]);
    } else if (!healthyStart) {
      assert(!started.ok && started.notSent && started.reason === 'unreachable');
      assert.equal(started.detail, 'Sign in to Antigravity CLI before starting a session.');
      if (initializeRequiresAuth) {
        const requests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(requests.map((request) => request.method), ['initialize']);
      }
    } else {
      assert(started.ok, JSON.stringify(started));
      assert.equal(started.value.status, 'running');
      if (configFixture) assert.deepEqual([started.value.model, started.value.effort], ['model-alt','low']);
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
      if (configFixture) assert.deepEqual([settled.value.model, settled.value.effort], ['model-alt','low']);
      assert.equal(settled.value.lastReply, 'Hello');
      assert.deepEqual(settled.value.turnEnds?.map((turn) => turn.message), ['Hello']);
      results.settled = settled;
      const requests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(requests.map((request) => request.method), [
        'initialize', 'session/new',
        ...(configFixture ? ['session/set_config_option', 'session/set_config_option'] : []),
        'session/prompt', undefined, 'session/close',
      ]);
      assert.deepEqual(requests.at(-2).result, { outcome: { outcome: 'cancelled' } });
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
      if (compactFixture) {
        const db = app.db.getDatabase();
        const root = 'neo:10000000-0000-4000-8000-000000000001';
        const now = Date.now();
        await app.db.createSession({
          id: root, title: 'Synthetic Neo', workspacePath: workspaceRoot,
          createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(),
          status: 'active', config: { queryMode: 'manual' },
          metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
        });
        new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
        const countCompactions = () => (readFileSync(journal, 'utf8').match(/"method":"compact"/g) ?? []).length;
        const delivered = queueNextTodo(db, started.value, root);
        if (busyReplacement) {
          const todos = new NeoAskTodoRepository(db);
          const sessions = new NeoTodoSessionRepository(db);
          const held = todos.addTodo('compact-held', 'compact-ask', { title: 'Held', doneWhen: 'Synthetic', check: null, instruction: 'Synthetic', named: null }, Date.now());
          sessions.create(held.id, { verb: 'send', ref: started.value.ref });
          sessions.recordRef(held.id, started.value.ref);
          todos.updateTodo(held, { state: 'doing', startedAt: Date.now() }, Date.now());
          if (worktreeReplacement) {
            const git = (...args: string[]) => {
              const result = spawnSync('git', ['-C', workspaceRoot, ...args], {
                encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
              });
              assert.equal(result.status, 0, result.stderr);
            };
            git('init', '-q');
            git('commit', '--allow-empty', '-qm', 'Fixture');
            const linked = join(run, 'old-worker');
            git('worktree', 'add', '-q', '--detach', linked, 'HEAD');
            db.prepare('UPDATE work_started_sessions SET folder = ? WHERE adapter = ? AND id = ?').run(linked, adapter, started.value.ref.id);
          }
          const next = todos.getTodo('compact-next')!;
          todos.updateTodo(next, { reason: 'Waiting for worker antigravity-cli:owned-1.' }, Date.now());
          writeFileSync(releaseCompaction, '');
          let replacementFolder: unknown;
          const runner = createNeoTodoRunner({
            limits: () => ({ running: 99, perGroup: 99 }),
            write: gatewayFor(db).run.bind(gatewayFor(db)), store: todos, sessions,
            invoke: (caller, name, input) => {
              if (name === 'work.start') replacementFolder = (input.place as { folder?: string })?.folder;
              return invokeOperation(app.sessionManager.getOperationRegistry(), name, input, caller);
            },
            workerCompact: () => undefined, packs: () => [], tell: async () => {}, attend: async () => {}, changed: () => {},
          });
          await runner.start('compact-next');
          if (worktreeReplacement) assert.equal(replacementFolder, workspaceRoot);
          const deadline = Date.now() + 5_000;
          while (!delivered() && Date.now() < deadline) await Bun.sleep(25);
          assert(delivered(), 'A new worker must take the waiting todo');
          assert.equal(sessions.readRef('compact-next')?.id, 'owned-2');
          assert.equal(todos.getTodo('compact-next')?.reason, null);
          results.busyReplacement = { fresh: true, waitReasonCleared: true, projectFolder: worktreeReplacement };
        } else {
        const startDeadline = Date.now() + 5_000;
        while (!countCompactions() && Date.now() < startDeadline) await Bun.sleep(25);
        assert.equal(countCompactions(), 1, 'Reuse runs one native compaction before the next todo');
        assert.equal(delivered(), false, 'The next todo must wait for the compaction');
        const busy = await send(started.value.ref.id);
        assert(!busy.ok && busy.reason === 'busy' && busy.notSent);
        writeFileSync(releaseCompaction, '');
        const completionDeadline = Date.now() + 5_000;
        while (!delivered() && Date.now() < completionDeadline) await Bun.sleep(25);
        assert(delivered(), 'The next todo must be dispatched after the compaction');
        const dispatched = new NeoTodoSessionRepository(db).readRef('compact-next');
        assert.equal(dispatched?.id, compactUnconfirmed ? 'owned-2' : started.value.ref.id);
        if (compactUnconfirmed) {
          const row = db.prepare("SELECT value_json FROM pack_facts WHERE todo_id = 'compact-next' AND pack = 'core' AND key = 'worker_reuse'").get() as { value_json: string };
          assert.equal(JSON.parse(row.value_json).reason, 'not_confirmed');
        }
        assert.equal(countCompactions(), 1);
        results.compaction = { unconfirmed: compactUnconfirmed, attempts: countCompactions() };
        }
      }
      if (historyFixture) {
        const read = (options: object) => rpc<z.infer<typeof ReadWorkResultSchema>>('work.read', {
          sessionId: started.value.ref.id, before: 1, after: 0, ...options,
        });
        const latest = await read(longHistory ? { before: 0 } : {});
        assert(latest.ok && latest.value.nextCursor, JSON.stringify(latest));
        assert.equal(latest.value.availability, 'incomplete');
        if (longHistory) {
          const first = latest.value.turns[0];
          assert.equal(first.text, 'x'.repeat(15999));
          assert.equal(first.textComplete, false);
          const rest = await read({ cursor: latest.value.nextCursor, before: 0 });
          assert(rest.ok);
          assert.deepEqual(rest.value.turns, [{
            messageId: first.messageId, role: 'assistant', at: 0,
            text: '😀tail', textComplete: true, textOffset: 15999,
          }]);
          assert(rest.value.nextCursor && !rest.value.nextCursor.resume);
        } else {
          assert.deepEqual(latest.value.turns.map(({ role, text }) => [role, text]), [
            ['user', 'Next question'], ['assistant', 'Second answer'],
          ]);
          const earlier = await read({ cursor: latest.value.nextCursor, before: 2 });
          assert(earlier.ok && earlier.value.availability === 'complete' && !earlier.value.nextCursor);
          assert.deepEqual(earlier.value.turns.map(({ role, text }) => [role, text]), [
            ['user', 'Opening question'], ['assistant', 'First answer'], ['user', 'Unanswered question'],
          ]);
          const anchored = await read({ around: earlier.value.turns[1].messageId, after: 1 });
          assert(anchored.ok);
          assert.deepEqual(anchored.value.turns.map(({ messageId }) => messageId),
            earlier.value.turns.map(({ messageId }) => messageId));
        }
        const unknown = await read({ sessionId: foreign.ref.id });
        assert(!unknown.ok && unknown.reason === 'not_found');
        const historyRequests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const expected = longHistory ? [
          'initialize', 'session/load', 'initialize', 'session/load',
        ] : [
          'initialize', 'session/load', 'initialize', 'session/load', 'initialize', 'session/load',
        ];
        assert.deepEqual(historyRequests.slice(-expected.length).map(({ method }) => method), expected);
        results.history = { messages: latest.value.turns.length, availability: latest.value.availability };
      }
      const stop = (id: string) => rpc<Result<{stopped: boolean}>>('work.stop', { ref: { adapter, id } });
      if (stopFixture) {
        const idle = await stop(started.value.ref.id);
        assert(idle.ok && !idle.value.stopped, JSON.stringify(idle));
        const unrelated = await stop(foreign.ref.id);
        assert(!unrelated.ok && unrelated.reason === 'not_found' && unrelated.notSent);
      }
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
        if (stopFixture) {
          let reports = 0;
          const stopping = [1, 2].map(async () => {
            const result = await stop(started.value.ref.id);
            reports += 1;
            return result;
          });
          const cancelDeadline = Date.now() + 5_000;
          while (!readFileSync(journal, 'utf8').includes('"session/cancel"') && Date.now() < cancelDeadline)
            await Bun.sleep(25);
          assert(readFileSync(journal, 'utf8').includes('"session/cancel"'));
          assert.equal(reports, 0);
          const duringCancel = await readFollowUp();
          assert(duringCancel.ok && duringCancel.value.status === 'running');
          writeFileSync(releaseFollowUp, '');
          if (holdClose) {
            const countCloseRequests = () => (readFileSync(journal, 'utf8').match(/"session\/close"/g) ?? []).length;
            const closeDeadline = Date.now() + 2_000;
            while (countCloseRequests() < 2 && Date.now() < closeDeadline) await Bun.sleep(25);
            assert.equal(countCloseRequests(), 2);
            const duringClose = await readFollowUp();
            assert(duringClose.ok && duringClose.value.status === 'running');
            stopping.push(stop(started.value.ref.id));
          }
          const stops = await Promise.all(stopping);
          assert(stops.every((result) => result.ok && result.value.stopped === !stopRace), JSON.stringify(stops));
          if (holdClose) {
            const beforeSave = await readFollowUp();
            assert(beforeSave.ok && beforeSave.value.status === 'running');
            writeFileSync(releaseClose, '');
          }
        } else writeFileSync(releaseFollowUp, '');
        const followUpDeadline = Date.now() + 5_000;
        let followUp = await readFollowUp();
        while (followUp.ok && followUp.value.status === 'running' && Date.now() < followUpDeadline) {
          await Bun.sleep(25);
          followUp = await readFollowUp();
        }
        const cancelled = stopFixture && !stopRace;
        assert(followUp.ok && followUp.value.status === (closeError ? 'failed' : cancelled ? 'stopped' : 'done'));
        assert.equal(followUp.value.lastReply, cancelled ? undefined : 'Hello again');
        if (closeError) {
          assert.match(followUp.value.turnEnds?.[0]?.message ?? '', /did not confirm saved history/);
        } else {
          assert.deepEqual(followUp.value.turnEnds?.map(({ message }) => message), [cancelled ? '' : 'Hello again']);
        }
        const input = followUp.value.inputEvidence;
        assert(input);
        assert.deepEqual(input.receipt, sent.value.receipt);
        if (cancelled || closeError) assert.equal(input.state, 'unavailable');
        else {
          assert(input.state === 'observed');
          assert.deepEqual(input.exchange.map(({ role, text }) => [role, text]), [
            ['user', 'Continue the greeting.'], ['agent', 'Hello again'],
          ]);
        }
        if (stopFixture) {
          const idle = await stop(started.value.ref.id);
          assert(idle.ok && !idle.value.stopped);
        }
        const resumedRequests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        const expected = [
          'initialize', 'session/resume', 'session/prompt', undefined,
          ...(stopFixture ? ['session/cancel'] : []), 'session/close',
        ];
        assert.deepEqual(resumedRequests.map(({ method }) => method).slice(-expected.length), expected);
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
