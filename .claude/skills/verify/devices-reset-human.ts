import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

type Reply = {
  ok: boolean; reason: string; approval: string; code: string; deviceId: string; credential: string;
  conversationId: string; resetAt: number; devices: { id: string; kind: string; revokedAt: number | null }[];
  items: { shortText: string; fullText: string }[];
};
const [port, run, phase] = process.argv.slice(2);
assert.notEqual(port, '8399');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const owned: WebSocketClientTransport[] = [];
const secrets: string[] = [];
const evidence: Record<string, unknown> = { phase };
async function connect(credential?: string) {
  const hub = new MessageHub({ defaultSessionId: 'global' });
  let closed: (code: number) => void = () => {};
  const closure = new Promise<number>((resolve) => { closed = resolve; });
  const transport = new WebSocketClientTransport({
    url: `ws://127.0.0.1:${port}/ws`, autoReconnect: false,
    createSocket: (url) => {
      const socket = credential ? new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) : new WebSocket(url);
      socket.addEventListener('close', (event) => closed(event.code));
      return socket;
    },
  });
  owned.push(transport); hub.registerTransport(transport); await transport.initialize();
  return { hub, closure, call: (name: string, input = {}) => hub.request<Reply>('operation.invoke', { name, input }) };
}
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, 'packages/cli/main.ts', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, error);
  const reply = JSON.parse(out) as Reply;
  if (reply.code) secrets.push(reply.code);
  return reply;
}
async function pair(code: string, name: string, status = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) });
  const reply = await response.json() as Reply;
  assert.equal(response.status, status);
  if (reply.credential) secrets.push(reply.credential);
  return reply;
}
const publicClient = await connect();
try {
  if (phase === 'initial') {
    const first = await cli('pair', '--name', 'Lost synthetic phone');
    const phone = await pair(first.code, 'Lost synthetic phone');
    const paired = await connect(phone.credential);
    const relayCode = await paired.call('device.pair.create', { kind: 'relay', name: 'Synthetic relay' });
    secrets.push(relayCode.code);
    const relay = await pair(relayCode.code, 'Synthetic relay');
    const relayClient = await connect(relay.credential);
    const oldCode = await paired.call('device.pair.create', { kind: 'human', name: 'Old code' });
    secrets.push(oldCode.code);
    assert.equal((await paired.call('device.reset_human')).ok, false);
    let changed = 0;
    publicClient.hub.onEvent('neo.publications.changed', () => { changed++; });
    const reset = await cli('devices', 'reset-human');
    evidence.reset = reset;
    assert.equal(reset.ok, true);
    const guidance = await publicClient.call('device.pair.create', { kind: 'human' });
    assert.equal(guidance.ok, false);
    assert(guidance.reason.includes('hyperneo devices reset-human'));
    evidence.networkPairGuidance = guidance.reason;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      evidence.closeCode = await Promise.race([paired.closure, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('revoked phone socket stayed open')), 2000); })]);
    } finally { clearTimeout(timer); }
    assert.equal(changed, 1);
    await pair(oldCode.code, 'Old code', 401);
    assert.equal((await relayClient.call('neo.snapshot')).ok, true);
    const devices = await cli('devices'); evidence.devices = devices.devices;
    assert.equal(devices.devices.length, 2);
    assert.equal(devices.devices.find((d) => d.id === phone.deviceId)?.revokedAt, reset.resetAt);
    assert.equal(devices.devices.find((d) => d.id === relay.deviceId)?.revokedAt, null);
    evidence.oldCodeRefused = true; evidence.noticeEvent = changed;
    await publicClient.call('neo.open');
  } else {
    const before = await cli('devices'); assert.equal(before.devices.length, 2);
    const first = await cli('pair'), second = await cli('pair');
    assert.equal(first.approval, 'approved'); assert.equal(second.approval, 'approved');
    await pair(first.code, 'Replacement synthetic phone');
    await pair(second.code, 'Extra synthetic phone', 403);
    assert.equal((await cli('pair')).approval, 'pending');
    evidence.recoverySurvivedRestart = true; evidence.extraCodeNeedsAllow = true;
    const list = await cli('devices'); assert.equal(list.devices.length, 3); evidence.devices = list.devices;
    await cli('devices', 'reset-human');
    const empty = await cli('devices', 'reset-human'); assert.equal(empty.devices.length, 0);
  }
  const snapshot = await publicClient.call('neo.snapshot');
  const publications = await publicClient.call('neo.publication.read', { conversationId: snapshot.conversationId, after: 0, limit: 100 });
  assert.equal(publications.ok, true);
  const notices = publications.items.filter((p) => p.shortText.startsWith('Human-device pairing reset at '));
  assert.equal(notices.length, phase === 'initial' ? 1 : 3);
  assert(notices[0].fullText.includes('Lost synthetic phone'));
  evidence.notices = notices;
  for (const secret of secrets) {
    assert(!JSON.stringify(evidence).includes(secret));
    assert(!(await readFile(join(run, `daemon-${phase}.log`), 'utf8')).includes(secret));
  }
  console.log(`PASS: ${phase} recovery and public Neo notice checks`);
} finally {
  await writeFile(join(run, 'evidence', `${phase}.json`), JSON.stringify(evidence, null, 2));
  for (const transport of owned) await transport.close();
}
