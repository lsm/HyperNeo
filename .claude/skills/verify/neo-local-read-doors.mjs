import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: neo-local-read-doors.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
const rpc = (name, input = {}) => {
  const reply = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
  })).reply;
  assert(!reply.error, JSON.stringify(reply));
  return reply.value ?? reply;
};

const evidence = {};

const opened = rpc('neo.open');
assert.equal(opened.ok, true, JSON.stringify(opened));
assert(opened.conversationId, 'neo.open returned no conversationId');
const asks = rpc('neo.conversation.asks.read', { conversationId: opened.conversationId });
assert.equal(asks.ok, true, JSON.stringify(asks));
evidence.openAndAsks = { sessionId: opened.sessionId, asksNextAfter: asks.nextAfter };

const image = rpc('neo.conversation.image.read', { conversationId: asks.conversationId, imageId: '1:0' });
assert.equal(image.ok, false);
assert.equal(image.reason, 'image_not_found');
evidence.imageBoundary = image;

const unpaired = rpc('device.unpaired.list');
assert.equal(unpaired.ok, true, JSON.stringify(unpaired));
const wouldRefuse = rpc('device.would_refuse.list');
assert.equal(wouldRefuse.ok, true, JSON.stringify(wouldRefuse));
evidence.deviceDiagnostics = { unpaired, wouldRefuse };

mkdirSync(`${run}/evidence`, { recursive: true });
writeFileSync(`${run}/evidence/neo-local-read-doors.json`, JSON.stringify(evidence, null, 1));
console.log('PASS local read doors:', run);
