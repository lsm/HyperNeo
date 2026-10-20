import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { seedNeoWake } from '../../../packages/daemon/tests/helpers/neo-wake-corpus.ts';

const [port, run] = process.argv.slice(2);
assert(port && run && port !== '8399');
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/`));
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  return result.reply;
}
const sessionId = (await rpc('neo.open', {})).sessionId;
const conversationId = sessionId.slice(4);
const db = new Database(`${run}/data/daemon.db`);
const fixture = seedNeoWake(db, conversationId);
const evidence: Record<string, unknown> = { expected: fixture.expected };
const save = () => writeFileSync(`${run}/evidence/neo-wake-contract.json`, JSON.stringify(evidence, null, 2));
try {
  evidence.before = await rpc('neo.conversation.read', { conversationId });
  save();
  const active = (evidence.before as { items: { role: string; wake?: { settledAt: number | null; summary: string | null; additions: unknown[] } }[] }).items.find((item) => item.role === 'wake')?.wake;
  assert(active, 'Delivered scheduled wake is missing from the conversation RPC');
  assert.equal(active.settledAt, null);
  assert.deepEqual(active.additions, fixture.expected);
  const last = await rpc('neo.conversation.read', { conversationId, limit: 1 });
  const first = await rpc('neo.conversation.read', { conversationId, limit: 1, before: last.nextBefore });
  const next = await rpc('neo.conversation.read', { conversationId, limit: 1, after: first.nextAfter });
  assert.deepEqual([...first.items, ...last.items], (evidence.before as typeof first).items);
  assert.deepEqual(next.items, last.items);
  evidence.pages = { first, last, next };
  fixture.finish(false, 'An unrelated later turn.');
  const later = await rpc('neo.conversation.read', { conversationId });
  evidence.unrelatedTerminal = later;
  assert.equal(later.items.find((item: { role: string }) => item.role === 'wake').wake.settledAt, null);
  const terminal = fixture.finish();
  db.prepare('UPDATE sdk_messages SET timestamp = ? WHERE sdk_uuid = ?').run(terminal.timestamp, fixture.messageId);
  evidence.after = await rpc('neo.conversation.read', { conversationId });
  evidence.snapshot = await rpc('neo.snapshot', {});
  save();
  const settled = (evidence.after as typeof later).items.find((item: { role: string }) => item.role === 'wake').wake;
  assert.equal(settled.settledAt, Date.parse(terminal.timestamp));
  assert.equal(settled.summary, 'Guide cycle complete.');
  assert.deepEqual((evidence.after as typeof later).items.find((item: { role: string }) => item.role === 'wake').cursor, (evidence.before as typeof later).items.find((item: { role: string }) => item.role === 'wake').cursor);
  assert.deepEqual((evidence.snapshot as { wakes: unknown[] }).wakes, [settled]);
  assert(!JSON.stringify(evidence.before).includes('PRIVATE_WAKE_INSTRUCTIONS'));
  console.log(`PASS: conversation RPC and snapshot expose the attributed wake; only matching consumed_seq settles it. ${run}/evidence/neo-wake-contract.json`);
} finally {
  db.close();
}
