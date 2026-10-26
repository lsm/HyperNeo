import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { feedCodexFiles } from '../../../packages/daemon/src/lib/drivers/codex-feed.ts';
import { claudeFeedSource } from '../../../packages/daemon/src/lib/drivers/claude-feed.ts';
import { feedWorkFiles } from '../../../packages/daemon/src/lib/drivers/work-feed.ts';

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
  const value = result.reply.value ?? result.reply;
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
    await rpc('daemon.attach', { daemonId: 'synthetic-owner', url: `ws://127.0.0.1:${port}` });
    const remote = await lookup('remote-only', { daemon: 'synthetic-owner' });
    assert.equal(remote.value.turns[0].messageId, 'peer-input');
    assert.deepEqual(remote.value.matchedInput, { adapter: 'codex-desktop', marker: marker('remote-only') });
    await app.cleanup(); app = await createDaemonApp({ config, verbose: false });
    await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
    assert.equal((await lookup('past')).value.turns[0].messageId, 'past-input');
    assert.equal((await lookup('future')).value.turns[0].messageId, 'future-input');
    writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ clockSkew: ['past', 'future'], interveningInputs: 160, nativeFeedIngested: true, exactOwningPeer: true, restart: true }, null, 2));
    console.log('PASS: exact native input lookup ignores clock and history windows, preserves scope across peer routing and restart');
  }
} finally {
  await app.cleanup();
  if (peer) { peer.stdin.end(); assert.equal(await peer.exited, 0); }
  for (const name of ['data', 'home', 'tmp', 'bin', 'peer', 'native-codex.jsonl', 'worker.jsonl']) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true }));
}
process.exit(0);
