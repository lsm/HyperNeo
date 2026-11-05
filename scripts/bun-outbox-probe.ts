import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseCore } from '../packages/daemon/src/storage/database-core.ts';
import { DbGateway } from '../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { claudeDesktopOutboxWrites } from '../packages/daemon/src/storage/repositories/claude-desktop-outbox-repository.ts';
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
  promptReport: false,
  exchangeReceipt: false,
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
  const sessionId = '3b286924-739c-487d-82d2-c3e36fd5ed36';
  const queued = await gateway.call(
    claudeDesktopOutboxWrites,
    'enqueueReported',
    sessionId,
    'session:neo',
    {
      kind: 'submit',
      text: 'complete synthetic prompt',
    }
  );
  assert(queued.id);
  const reported = db
    .prepare('SELECT COUNT(*) AS n FROM job_queue WHERE queue = ? AND payload LIKE ?')
    .get('mailbox', '%driver:claude-desktop:' + sessionId + '%');
  assert.equal(reported?.n, 1);
  evidence.promptReport = true;
  const reply = await gateway.call(
    claudeDesktopOutboxWrites,
    'exchange',
    {
      version: 1,
      sessionId,
      instanceId: sessionId + ':1:1',
      events: [{ sequence: 1, kind: 'session.start' }],
    },
    4242,
    true
  );
  const journal = db
    .prepare('SELECT last_sequence FROM claude_desktop_bridge_instances WHERE session_id = ?')
    .get(sessionId);
  assert.equal(reply.ack, 1);
  assert.equal(reply.command?.id, queued.id);
  assert.deepEqual(reply.command, {
    id: queued.id,
    instanceId: sessionId + ':1:1',
    kind: 'submit',
    from: 'session:neo',
    text: 'complete synthetic prompt',
  });
  assert.equal(journal?.last_sequence, 1);
  evidence.exchangeReceipt = true;
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
      writeFileSync(join(run, 'evidence/bun-outbox.json'), JSON.stringify(evidence, null, 2));
    }
  }
}
