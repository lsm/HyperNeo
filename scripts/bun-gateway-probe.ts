import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../packages/daemon/src/storage/database-core.ts';
import { DbGateway } from '../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { recordWouldRefuse } from '../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { waitForSdkBodyCopy } from '../.claude/skills/verify/wait-for-sdk-body-copy.ts';

const run = resolve(process.argv[2] ?? '');
assert(process.versions.bun, 'Use Bun for this probe');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')), 'Probe requires fresh owned data');
for (const key of [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
])
  assert.equal(process.env[key], undefined);
for (const folder of ['home', 'data', 'evidence'])
  mkdirSync(join(run, folder), { recursive: true });

const path = join(run, 'data/daemon.db');
const core = new DatabaseCore(path);
let initialized = false;
let gateway: DbGateway | undefined;
const evidence = {
  runtime: 'bun',
  startupBodyCopyComplete: false,
  serializedWrites: false,
  unknownReadRejected: false,
  gatewayClosed: false,
  databaseClosed: false,
  pass: false,
};
try {
  await core.initialize();
  initialized = true;
  core.startSdkMessageBodyCopy();
  const db = core.getDb();
  await waitForSdkBodyCopy(db);
  evidence.startupBodyCopyComplete = true;
  gateway = new DbGateway(path, null);
  const seen = { reason: 'host_not_allowed', kind: 'ws', host: 'bun-gateway.test', origin: null };
  const writer = gateway;
  await Promise.all([1, 2].map((now) => writer.run(recordWouldRefuse, { seen, now })));
  await assert.rejects(
    gateway.run({ name: 'bun.unknown', mode: 'read', run: () => 1 }, undefined),
    /Unknown read DB op: bun\.unknown/
  );
  evidence.unknownReadRejected = true;
  const row = db.prepare('SELECT count FROM would_refuse_requests WHERE host = ?').get(seen.host);
  assert.equal(row?.count, 2);
  evidence.serializedWrites = true;
  evidence.pass = true;
} finally {
  try {
    await gateway?.close();
    evidence.gatewayClosed = gateway !== undefined;
  } finally {
    try {
      if (initialized) {
        core.close();
        evidence.databaseClosed = true;
      }
    } finally {
      writeFileSync(join(run, 'evidence/bun-gateway.json'), JSON.stringify(evidence, null, 2));
    }
  }
}
