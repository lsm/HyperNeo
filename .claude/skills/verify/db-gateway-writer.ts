import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunSqlite } from 'bun:sqlite';
import { ingestSessionEvent } from '../../../packages/daemon/src/lib/external-events/session-external-event-store.ts';
import { DbGateway } from '../../../packages/daemon/src/storage/db-gateway/db-gateway.ts';
import { claudeDesktopOutboxWrites } from '../../../packages/daemon/src/storage/repositories/claude-desktop-outbox-repository.ts';
import {
  cleanupJobs,
  jobQueueWrites,
} from '../../../packages/daemon/src/storage/repositories/job-queue-repository.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { purgeWorkFeedSessions } from '../../../packages/daemon/src/storage/work-feed.ts';

const run = process.argv[2];
mkdirSync(run, { recursive: true });
const path = join(run, 'synthetic.db');
const main = new Database(path);
main.exec('PRAGMA journal_mode=WAL');
runMigrations(main, () => {});
createTables(main);
main.close();

const check = (ok: boolean, label: string) => {
  if (!ok) throw new Error(`FAILED: ${label}`);
  console.log(`ok ${label}`);
};
const gateway = new DbGateway(path, null);
const db = new BunSqlite(path);
try {
  const event = {
    id: 'verify-writer',
    spaceId: 'sessions',
    source: 'github',
    topic: 'github/synthetic/writer/pull_request/1.review_submitted',
    dedupeKey: 'verify-once',
    occurredAt: 1,
    ingestedAt: 2,
    summary: 'Synthetic',
    payload: { body: 'complete synthetic result' },
  };
  const first = await gateway.run(ingestSessionEvent, event);
  const again = await gateway.run(ingestSessionEvent, { ...event, id: 'verify-duplicate' });
  check(first.action === 'ingested' && again.action === 'duplicate', 'ingest commits once');

  const insert = db.prepare(
    `INSERT INTO message_search_content(kind,source_id,session_id,message_type,title,body,timestamp)
     VALUES (?, ?, ?, 'user', 'Synthetic', 'complete retained result', 1)`
  );
  for (let i = 0; i < 1200; i++) insert.run('claude', `purge-${i}`, 'verify-purge');
  insert.run('codex', 'keep', 'verify-purge');
  const claim = db.prepare(
    `INSERT INTO job_queue(id,queue,status,payload,run_at,created_at) VALUES(?, 'verify-claim', 'pending', '{}', 0, 0)`
  );
  claim.run('verify-claim');
  const [purged, claimed] = await Promise.all([
    purgeWorkFeedSessions(gateway, 'claude', ['verify-purge']),
    gateway.call(jobQueueWrites, 'dequeue', 'verify-claim', 5),
  ]);
  const left = db
    .prepare('SELECT kind FROM message_search_content WHERE session_id = ?')
    .all('verify-purge');
  check(purged === undefined && left.length === 1, 'batched purge keeps other feed kinds');
  check(claimed.length === 1 && Boolean(claimed[0].claimToken), 'claim runs between purge batches');
  check(
    (await gateway.run(cleanupJobs, { beforeMs: 0, completed: [] })) === 0,
    'cleanup keeps young jobs'
  );

  const sid = '3b286924-739c-487d-82d2-c3e36fd5ed36';
  const queued = await gateway.call(claudeDesktopOutboxWrites, 'enqueueReported', sid, 'session:neo', {
    kind: 'submit',
    text: 'complete synthetic prompt',
  });
  const reported = db
    .prepare("SELECT COUNT(*) AS n FROM job_queue WHERE queue = 'mailbox'")
    .get() as { n: number };
  check(Boolean(queued.id) && reported.n === 1, 'outbox enqueue and its report commit together');
  const reply = await gateway.call(
    claudeDesktopOutboxWrites,
    'exchange',
    { version: 1, sessionId: sid, instanceId: `${sid}:1:1`, events: [{ sequence: 1, kind: 'session.start' }] },
    4242,
    true
  );
  const journal = db
    .prepare('SELECT last_sequence FROM claude_desktop_bridge_instances WHERE session_id = ?')
    .get(sid) as { last_sequence: number } | null;
  check(
    reply.ack === 1 && reply.command?.id === queued.id && journal?.last_sequence === 1,
    'bridge exchange journals the event and hands out the queued prompt'
  );
} finally {
  db.close();
  await gateway.close();
}
