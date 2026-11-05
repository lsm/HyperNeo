import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ingestSessionEvent } from '../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { DatabaseCore } from '../packages/daemon/src/storage/database-core.ts';
import { DbGateway } from '../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import {
  cleanupJobs,
  jobQueueWrites,
} from '../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { purgeWorkFeedSessions } from '../packages/daemon/src/storage/work-feed.ts';
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
  duplicateEventIdentity: false,
  retainedFeedBody: false,
  cleanupCutoffs: false,
  retainedJobPayload: false,
  singleClaimPayload: false,
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
  const event = {
    id: 'bun-writer',
    spaceId: 'sessions',
    source: 'github',
    topic: 'github/synthetic/writer/pull_request/1.review_submitted',
    dedupeKey: 'bun-once',
    occurredAt: 1,
    ingestedAt: 2,
    summary: 'Synthetic',
    payload: { body: 'complete synthetic result' },
  };
  const first = await gateway.run(ingestSessionEvent, event);
  const duplicate = await gateway.run(ingestSessionEvent, { ...event, id: 'bun-duplicate' });
  assert.equal(first.action, 'ingested');
  assert(duplicate.action === 'duplicate');
  assert.equal(duplicate.eventId, event.id);
  evidence.duplicateEventIdentity = true;

  const insert = db.prepare(
    'INSERT INTO message_search_content(kind,source_id,session_id,message_type,title,body,timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const kind of ['claude', 'codex'])
    insert.run(
      kind,
      'bun-purge-' + kind,
      'bun-purge-sdk',
      'user',
      'Synthetic',
      'complete retained result',
      1
    );
  await purgeWorkFeedSessions(gateway, 'claude', ['bun-purge-sdk']);
  const rows = db
    .prepare('SELECT kind,body FROM message_search_content WHERE session_id=?')
    .all('bun-purge-sdk');
  assert.deepEqual(rows, [{ kind: 'codex', body: 'complete retained result' }]);
  evidence.retainedFeedBody = true;

  const now = Date.now(),
    hour = 3600000;
  const job = db.prepare(
    'INSERT INTO job_queue(id,queue,status,payload,priority,max_retries,retry_count,run_at,created_at,completed_at) VALUES(?,?,?,?,0,3,0,?,?,?)'
  );
  for (const [id, queue, status, age] of [
    ['bun-cleanup-old', 'synthetic-cleanup', 'completed', 8 * 24 * hour],
    ['bun-cleanup-reminder', 'longHorizonAgentReminder.fire', 'completed', 2 * hour],
    ['bun-cleanup-keep', 'longHorizonAgentReminder.fire', 'failed', 2 * hour],
  ] as const)
    job.run(
      id,
      queue,
      status,
      JSON.stringify({ body: 'complete retained job' }),
      now - age,
      now - age,
      now - age
    );
  const count = await gateway.run(cleanupJobs, {
    beforeMs: now - 7 * 24 * hour,
    completed: [{ queue: 'longHorizonAgentReminder.fire', beforeMs: now - hour }],
  });
  assert.equal(count, 2);
  evidence.cleanupCutoffs = true;
  const kept = db.prepare('SELECT id,payload FROM job_queue WHERE id LIKE ?').all('bun-cleanup-%');
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.id, 'bun-cleanup-keep');
  assert.deepEqual(JSON.parse(String(kept[0]?.payload)), { body: 'complete retained job' });
  evidence.retainedJobPayload = true;

  db.prepare(
    'INSERT INTO job_queue(id,queue,status,payload,run_at,created_at) VALUES(?,?,?,?,?,?)'
  ).run(
    'bun-claim',
    'synthetic-claim',
    'pending',
    JSON.stringify({ body: 'complete claim payload' }),
    now,
    now
  );
  const claimed = await gateway.call(jobQueueWrites, 'dequeue', 'synthetic-claim', 5);
  const again = await gateway.call(jobQueueWrites, 'dequeue', 'synthetic-claim', 5);
  assert.equal(claimed.length, 1);
  assert.deepEqual(again, []);
  assert(claimed[0]?.claimToken);
  assert.deepEqual(claimed[0]?.payload, { body: 'complete claim payload' });
  evidence.singleClaimPayload = true;
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
      writeFileSync(join(run, 'evidence/bun-event-job.json'), JSON.stringify(evidence, null, 2));
    }
  }
}
