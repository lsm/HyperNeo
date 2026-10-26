import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync, rmSync, chmodSync, appendFileSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { feedCodexFiles } from '../../../packages/daemon/src/lib/drivers/codex-feed.ts';
import { claudeFeedSource } from '../../../packages/daemon/src/lib/drivers/claude-feed.ts';
import { feedWorkFiles } from '../../../packages/daemon/src/lib/drivers/work-feed.ts';
import { claudeInboxFrame } from '../../../packages/daemon/src/lib/drivers/claude-inbox.ts';

const peerMode = process.argv[2] === 'peer';
const run = resolve(process.argv[peerMode ? 3 : 2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
for (const command of ['gh', 'open', 'ps']) {
  const path = join(run, 'bin', command);
  writeFileSync(path, '#!/bin/sh\nexit 1\n'); chmodSync(path, 0o700);
}
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const desktopRecords = join(run, 'home/Library/Application Support/Claude/claude-code-sessions/account/scope');
const claudeOwner = '11111111-1111-4111-8111-111111111111';
mkdirSync(desktopRecords, { recursive: true });
writeFileSync(join(desktopRecords, 'local_card.json'), JSON.stringify({ sessionId: 'local_card', cliSessionId: claudeOwner, cwd: '/synthetic-proof-project' }));
const copilotFixture = resolve(import.meta.dir, '../../../packages/daemon/tests/fixtures/copilot-sdk.ts');
const acpFixture = resolve(import.meta.dir, '../../../packages/daemon/tests/fixtures/copilot-acp.ts');
writeFileSync(join(run, 'bin/copilot'), `#!/usr/bin/env bun\nif (process.argv.includes('--acp')) await import(${JSON.stringify(acpFixture)}); else { process.argv.push('--production-version', '--durable-inputs'); await import(${JSON.stringify(copilotFixture)}); }\n`, { mode: 0o700 });
mkdirSync(join(run, 'home/evidence'), { recursive: true });
writeFileSync(join(run, 'home/copilot-list.json'), '[]');
mkdirSync(join(run, 'workspace'), { recursive: true });
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
let app = await createDaemonApp({ config, verbose: false });
let peer: ReturnType<typeof Bun.spawn> | undefined;
const receipts: unknown[] = [];
const marker = (name: string) => `[worker-answer:${name}]`;
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0); assert(!result.reply.error, JSON.stringify(result));
  const value = result.reply;
  receipts.push({ name, input, value });
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify(receipts, null, 2));
  return value;
}
async function seed() {
  const codex = (id: string, role: string, text: string, at: string) => ({ type: 'response_item', timestamp: at, payload: { type: 'message', role, id, content: [{ type: 'input_text', text }] } });
  const source = [
    { type: 'session_meta', payload: { id: 'worker', cwd: '/synthetic-proof-project' } },
    codex('past-input', 'user', `${marker('past')}\nAnswer behind local clock`, '1990-01-01T00:00:00Z'),
    codex('future-input', 'user', `${marker('future')}\nAnswer ahead of local clock`, '2090-01-01T00:00:00Z'),
    codex('quoted', 'assistant', `${marker('quote')}\nOnly an agent quotation`, '2090-01-01T00:00:00Z'),
    codex('partial', 'user', `${marker('partial')}suffix\nDifferent identity`, '2090-01-01T00:00:00Z'),
    ...(peerMode ? [codex('peer-input', 'user', `${marker('remote-only')}\nOnly the owning daemon has this`, '1980-01-01T00:00:00Z')] : []),
    ...Array.from({ length: 160 }, (_, n) => codex(`noise-${n}`, 'user', `Unrelated input ${n}`, '2026-01-01T00:00:00Z')),
  ];
  const codexPath = join(run, 'native-codex.jsonl');
  writeFileSync(codexPath, source.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const files = (path: string) => [{ path, size: statSync(path).size, mtime: Math.floor(statSync(path).mtimeMs) }];
  await feedCodexFiles(app.db.getDatabase(), files(codexPath));
  const claudePath = join(run, 'worker.jsonl');
  writeFileSync(claudePath, JSON.stringify({ type: 'user', uuid: 'claude-input', cwd: '/synthetic-proof-project', timestamp: '1990-01-01T00:00:00Z', message: { content: `${marker('claude-only')}\nClaude input with the same session ID` } }) + '\n');
  await feedWorkFiles(app.db.getDatabase(), files(claudePath), claudeFeedSource(new Set()));
  const nativeClaude = join(run, `${claudeOwner}.jsonl`);
  const nativeAt = '1990-01-01T00:00:00Z';
  const wrapper = JSON.parse(claudeInboxFrame({ sessionId: claudeOwner, pid: 1, socketPath: '/synthetic.sock', version: 'synthetic' }, '/synthetic-reply.sock', { messageId: '22222222-2222-4222-8222-222222222222', inputId: '33333333-3333-4333-8333-333333333333', text: `${marker('native-wrapper')}\nStored answer` }));
  const nativeRows = [
    wrapper,
    { type: 'user', uuid: 'meta-peer', isMeta: true, origin: { kind: 'peer', body: `${marker('native-meta')}\nStored answer` } },
    { type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'peer', body: `${marker('native-queued')}\nStored answer` } } },
    ...Array.from({ length: 160 }, (_, n) => ({ type: 'user', uuid: `noise-${n}`, message: { content: `Later input ${n}` } })),
  ];
  writeFileSync(nativeClaude, nativeRows.map((row) => JSON.stringify({ ...row, cwd: '/synthetic-proof-project', timestamp: nativeAt })).join('\n') + '\n');
  await feedWorkFiles(app.db.getDatabase(), files(nativeClaude), claudeFeedSource(new Set()));
}
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  await seed();
  if (peerMode) {
    console.log(JSON.stringify({ port: app.server.port }));
    await new Response(Bun.stdin).text();
  } else {
    const lookup = (name: string, extra: Record<string, unknown> = {}, adapter = 'codex-desktop') => rpc('work.read', { sessionId: 'worker', input: { adapter, marker: marker(name) }, ...extra });
    for (const name of ['past', 'future']) {
      const found = await lookup(name);
      assert.equal(found.ok, true, JSON.stringify(found));
      assert.deepEqual(found.value.matchedInput, { adapter: 'codex-desktop', marker: marker(name) });
      assert.equal(found.value.turns[0].messageId, `${name}-input`);
    }
    for (const name of ['quote', 'partial', 'missing', 'claude-only', 'remote-only']) assert.equal((await lookup(name)).ok, false, name);
    assert.equal((await lookup('past', { sessionId: 'other-worker' })).ok, false);
    assert.equal((await lookup('claude-only', {}, 'claude-code')).value.turns[0].messageId, 'claude-input');
    for (const name of ['native-wrapper', 'native-meta', 'native-queued']) {
      const desktop = await lookup(name, { sessionId: 'local_card' }, 'claude-desktop');
      assert.equal(desktop.ok, true, JSON.stringify(desktop));
      assert.equal(desktop.value.turns[0].role, 'user');
      assert.equal((await lookup(name, { sessionId: claudeOwner }, 'claude-code')).value.turns[0].messageId, desktop.value.turns[0].messageId);
    }
    assert.equal((await lookup('native-wrapper', { sessionId: claudeOwner }, 'claude-desktop')).ok, false, 'a raw CLI ID must not impersonate its Desktop owner');
    const started = await rpc('work.start', { adapter: 'copilot-cli', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic' }, title: 'Owned history', model: 'synthetic-model', message: 'history' });
    assert(started.ok, JSON.stringify(started));
    const copilotId = started.value.ref.id;
    const copilotHistory = join(run, 'data/copilot-workers', copilotId, 'session-state', copilotId, 'events.jsonl');
    for (const [name, timestamp] of [['past', '1990-01-01T00:00:00Z'], ['future', '2090-01-01T00:00:00Z']])
      appendFileSync(copilotHistory, JSON.stringify({ type: 'user.message', timestamp, data: { messageId: `${name}-copilot`, content: `${marker(name)}\nStored answer` } }) + '\n');
    for (let n = 0; n < 160; n++) appendFileSync(copilotHistory, JSON.stringify({ type: 'user.message', timestamp: '2026-01-01T00:00:00Z', data: { messageId: `noise-${n}`, content: 'x'.repeat(2000) } }) + '\n');
    for (const name of ['past', 'future']) assert.equal((await lookup(name, { sessionId: copilotId }, 'copilot-cli')).value.turns[0].messageId, `user:${name}-copilot`);
    assert.equal((await lookup('past', { sessionId: 'external' }, 'copilot-cli')).ok, false);
    const peerRun = join(run, 'peer');
    for (const dir of ['home', 'tmp']) mkdirSync(join(peerRun, dir), { recursive: true });
    peer = Bun.spawn([process.execPath, import.meta.path, 'peer', peerRun], {
      env: { ...process.env, HOME: join(peerRun, 'home'), TMPDIR: join(peerRun, 'tmp'), HYPERNEO_DATA_DIR: join(peerRun, 'data') }, stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
    });
    const reader = peer.stdout.getReader();
    let ready = '';
    while (!ready.includes('\n')) { const part = await reader.read(); assert(!part.done); ready += new TextDecoder().decode(part.value); }
    reader.releaseLock();
    const port = JSON.parse(ready.split('\n')[0]).port;
    await rpc('daemon.attach', { daemonId: 'synthetic-owner', url: `ws://127.0.0.1:${port}/ws` });
    const remote = await lookup('remote-only', { daemon: 'synthetic-owner' });
    assert.equal(remote.value.turns[0].messageId, 'peer-input');
    assert.deepEqual(remote.value.matchedInput, { adapter: 'codex-desktop', marker: marker('remote-only') });
    await app.cleanup(); app = await createDaemonApp({ config, verbose: false });
    await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
    assert.equal((await lookup('past')).value.turns[0].messageId, 'past-input');
    assert.equal((await lookup('future')).value.turns[0].messageId, 'future-input');
    for (const name of ['native-wrapper', 'native-meta', 'native-queued']) assert.equal((await lookup(name, { sessionId: 'local_card' }, 'claude-desktop')).ok, true);
    for (const name of ['past', 'future']) assert.equal((await lookup(name, { sessionId: copilotId }, 'copilot-cli')).value.turns[0].messageId, `user:${name}-copilot`);
    assert(!readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').includes('session.resume'), 'history lookup must not resume the peer');
    writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ clockSkew: ['past', 'future'], interveningInputs: 160, nativeFeedIngested: true, exactOwningPeer: true, restart: true, desktopAlias: true, nativePeerEnvelopes: true, queuedPeerAttachment: true, copilotBeyondByteWindow: true }, null, 2));
    console.log('PASS: exact native input lookup ignores clock and history windows, preserves scope across peer routing and restart');
  }
} finally {
  await app.cleanup();
  if (peer) { peer.stdin.end(); assert.equal(await peer.exited, 0); }
  for (const name of ['data', 'home', 'tmp', 'bin', 'peer', 'workspace', 'native-codex.jsonl', 'worker.jsonl', `${claudeOwner}.jsonl`]) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true }));
}
process.exit(0);
