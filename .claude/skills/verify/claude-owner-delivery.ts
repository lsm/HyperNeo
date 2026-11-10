import { strict as assert } from 'node:assert';
import { createConnection, createServer } from 'node:net';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const repo = resolve(import.meta.dir, '../../..');
const installed = process.argv[2] === 'desktop';
const { createDaemonApp } = await import(join(repo, 'packages/daemon/src/app.ts'));
const { getConfig } = await import(join(repo, 'packages/daemon/src/config.ts'));
const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.NODE_ENV, 'test');
assert(!existsSync(join(run, 'data')));
const evidence = join(run, 'evidence'), cwd = join(run, 'workspace');
const records = join(run, 'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account');
const registrations = join(run, 'home/.claude/sessions');
const projects = join(run, 'home/.claude/projects', cwd.replace(/[/.]/g, '-'));
for (const dir of [evidence, cwd, registrations]) mkdirSync(dir, { recursive: true });
chmodSync(registrations, 0o700);
const id = crypto.randomUUID(), pid = 9001;
const state = { id, title: 'Synthetic target', cwd, permissionMode: 'auto', pid, status: 'idle' };
let mode = 'prompting';
const stateFile = join(evidence, 'native-sessions.json');
const saveState = (rows = [state]) => writeFileSync(stateFile, JSON.stringify(rows));
saveState();
const registrationFile = join(registrations, `${pid}.json`), socketPath = join(registrations, `${pid}.sock`);
const registration = { sessionId: id, pid, procStart: 1, entrypoint: installed ? 'claude-desktop' : 'sdk-cli', version: '2.1.302', peerProtocol: 1, peerFeatures: ['notify_idle'], messagingSocketPath: socketPath };
const saveRegistration = (value: unknown = registration) => writeFileSync(registrationFile, JSON.stringify(value));
saveRegistration();
const transcript = join(projects, `${id}.jsonl`);
const fixture = join(repo, 'packages/daemon/tests/fixtures/claude-b1-cli.ts');
writeFileSync(join(run, 'bin/claude'), `#!/usr/bin/env bun\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
for (const name of ['gh', 'open']) writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(evidence, 'process-mode'), 'auto');
writeFileSync(join(run, 'bin/ps'), `#!/bin/sh\nprintf '%s\\n' '${pid} 1 ${pid} 00:20 claude --resume ${id} --permission-mode '$(cat '${join(evidence, 'process-mode')}')\n`, { mode: 0o700 });
let policy = 'accept';
type PeerFrame = { msg_id: string; uuid: string; from: string; message: { content: string } };
const observed: unknown[] = [], frames: (PeerFrame & { receiverStatus: string; receiverMode: string })[] = [], receipts: { at: number; inputId: string; status: string }[] = [], pending = new Map<string, PeerFrame>();
const timers = new Set<ReturnType<typeof setTimeout>>();
function receipt(frame: PeerFrame, status: string) {
  receipts.push({ at: Date.now(), inputId: frame.msg_id, status });
  const reply = createConnection(frame.from.slice(4));
  reply.on('error', error => observed.push({ receiptError: String(error) }));
  reply.once('connect', () => reply.end(JSON.stringify({ type: 'control', action: 'peer_message_status', from: `uds:${socketPath}`, orig_msg_id: frame.msg_id, status }) + '\n'));
}
function accept(frame: PeerFrame) {
  appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: frame.uuid, timestamp: new Date().toISOString(), message: { role: 'user', content: frame.message.content } }) + '\n');
}
const peer = createServer(socket => {
  let buffer = ''; socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk; if (!buffer.endsWith('\n')) return;
    const frame = JSON.parse(buffer); frames.push({ ...frame, receiverStatus: state.status, receiverMode: mode });
    const sender = /from-mode="([^"]+)"/.exec(frame.message.content)?.[1];
    if (policy === 'accept' && sender === mode) accept(frame);
    else if (policy === 'refuse') receipt(frame, 'refused');
    else {
      pending.set(frame.msg_id, frame); receipt(frame, 'held');
      const timer = setTimeout(() => { timers.delete(timer); if (pending.delete(frame.msg_id)) receipt(frame, 'expired'); }, 250);
      timers.add(timer);
    }
    socket.end();
  });
});
await new Promise<void>(done => peer.listen(socketPath, done)); chmodSync(socketPath, 0o600);
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined, ws: WebSocket | undefined;
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
try {
  assert(!existsSync(projects) && !existsSync(join(run, 'home/Library/Application Support/Claude/claude-code-sessions')));
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  assert.notEqual(app.server.port, 8399);
  mkdirSync(projects, { recursive: true }); writeFileSync(transcript, ''); if (installed) { mkdirSync(records, { recursive: true }); writeFileSync(join(records, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, cwd, title: 'Synthetic target', permissionMode: 'auto' })); }
  await app.jobProcessor.stop();
  await app.db.createSession({ id: 'synthetic-origin', title: 'Synthetic origin', workspacePath: cwd, createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC connection failed')); });
  const send = (label: string, adapter = 'claude-code', target = id) => new Promise<import('../../../packages/daemon/src/lib/drivers/types.ts').Result<import('../../../packages/daemon/src/lib/drivers/types.ts').WorkDelivery>>((done, fail) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error('RPC timeout')), 45000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data)); if (reply.id !== requestId && reply.requestId !== requestId) return;
      clearTimeout(timer); ws!.removeEventListener('message', receive); observed.push({ label, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.addEventListener('message', receive);
    ws!.send(JSON.stringify({ id: requestId, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'work.send', input: { ref: { adapter, id: target }, from: 'session:synthetic-origin', message: label } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const modes = installed ? ['auto'] : ['default', 'auto', 'plan', 'bypassPermissions'];
  for (const receiverMode of modes) {
    mode = receiverMode === 'bypassPermissions' ? 'bypass' : 'prompting';
    writeFileSync(join(evidence, 'process-mode'), receiverMode);
    for (const status of ['idle', 'busy']) {
      state.status = status; saveState();
      const marker = `ACCEPT_${receiverMode}_${status}`;
      const result = await send(marker);
      assert(result.ok, JSON.stringify(result));
      assert(readFileSync(transcript, 'utf8').includes(marker));
      assert.equal(receipts.filter(r => r.inputId === result.value.receipt.inputId).length, 0);
      if (installed) assert(result.value.delivered, 'Desktop alias must confirm transcript delivery');
      else assert(result.value.unconfirmed, 'CLI socket writes remain explicitly unconfirmed');
    }
  }
  if (installed) {
    state.pid = 0; saveState();
    const stopped = await send('STOPPED_DESKTOP_ALIAS');
    assert(stopped.ok && stopped.value.delivered, JSON.stringify(stopped));
    const events = readFileSync(join(evidence, 'native-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(e => e.kind === 'headless-turn').length, 1);
    assert(!events.some(e => e.kind === 'relay'));
    state.pid = pid; saveState();
    saveRegistration({ ...registration, entrypoint: 'sdk-cli' });
    mode = 'prompting'; writeFileSync(join(evidence, 'process-mode'), 'auto');
    const registeredCli = await send('REGISTERED_DESKTOP_CLI_OWNER');
    assert(registeredCli.ok && registeredCli.value.delivered, JSON.stringify(registeredCli));
  } else {
    mode = 'prompting'; writeFileSync(join(evidence, 'process-mode'), 'auto');
    for (const receiverPolicy of ['hold', 'refuse']) {
      policy = receiverPolicy;
      const before = frames.length;
      const result = await send(`POLICY_${policy}`);
      assert(result.ok && result.value.unconfirmed, JSON.stringify(result));
      await delay(450);
      assert.equal(frames.length, before + 1, 'Never auto-resend a held or refused input');
      assert(!readFileSync(transcript, 'utf8').includes(`POLICY_${policy}`));
      assert(receipts.some(r => r.inputId === result.value.receipt.inputId && r.status === (policy === 'hold' ? 'held' : 'refused')));
    }
    policy = 'accept';
    writeFileSync(join(evidence, 'process-mode'), 'future-mode');
    const before = frames.length;
    const unknownMode = await send('UNKNOWN_MODE');
    assert(!unknownMode.ok && unknownMode.reason === 'unsupported', JSON.stringify(unknownMode));
    assert.match(unknownMode.detail, /receiver.*mode.*unknown/i);
    assert.equal(frames.length, before);
    writeFileSync(join(evidence, 'process-mode'), 'auto');
    writeFileSync(stateFile, 'invalid discovery output'); const failedProbe = await send('LIVE_PROBE_FAILURE'); assert(!failedProbe.ok && failedProbe.reason === 'unreachable', JSON.stringify(failedProbe)); assert.equal(frames.length, before); saveState();
  }
  saveRegistration({ ...registration, entrypoint: 'unknown-host' });
  const beforeRejected = frames.length;
  const unknown = await send('UNKNOWN_REGISTRATION'); assert(!unknown.ok && unknown.reason === 'unreachable');
  saveRegistration(); saveState([state, { ...state, pid: 9002 }]);
  const ambiguous = await send('DUPLICATE_UUID'); assert(!ambiguous.ok && ambiguous.reason === 'unreachable');
  if (!installed) {
    saveState([]); const stopped = await send('STOPPED_TARGET'); assert(!stopped.ok && stopped.reason === 'unreachable');
  }
  saveState(); const wrongId = await send('DESKTOP_ID_ON_CODE_ROUTE', 'claude-code', `local_${id}`); assert(!wrongId.ok && wrongId.reason === 'unreachable');
  assert.equal(frames.length, beforeRejected, 'Ownership rejections never write');
  await delay(400);
  const raw = app.db.getDatabase();
  const receiptJobs = raw.query("SELECT queue, status, payload FROM job_queue WHERE payload LIKE '%Claude inbox transport fact%'").all();
  observed.push({ result: 'pass', installed, syntheticPeer: true, expiryMs: 250, port: app.server.port, receiptJobs });
  console.log(`PASS: isolated daemon ${installed ? 'registered Desktop live/stopped/CLI-owned' : 'Desktop absent; CLI default/auto/plan/bypass; unknown mode; hold/refuse without resend'}; owner uniqueness and wrong-id refusal.`);
} finally {
  for (const timer of timers) clearTimeout(timer);
  ws?.close(); await app?.cleanup(); await new Promise<void>(done => peer.close(() => done()));
  writeFileSync(join(evidence, 'observed.json'), JSON.stringify({ observed, frames, receipts, resourcesClosed: true }, null, 2));
}
