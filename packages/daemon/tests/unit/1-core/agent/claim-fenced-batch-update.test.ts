import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';

const SESSION = 'session-1';
const KICKOFF = 'kickoff-1';

describe('claim-fenced status transitions + admission reservation primitives', () => {
  let db: Database;
  let repository: JobQueueRepository;

  const insertMessage = (uuid: string, sendStatus: string, messageType: string = 'user'): void => {
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
       VALUES (?, ?, ?, '{}', ?, ?, ?)`
    ).run(uuid, SESSION, messageType, new Date().toISOString(), sendStatus, uuid);
  };

  const claimDeliveryJob = (batchUuids: string[]): { jobId: string; claimToken: string } => {
    repository.enqueue({
      queue: 'message_delivery',
      payload: {
        sessionId: SESSION,
        messageUuid: KICKOFF,
        role: 'turn',
        origin: 'chat',
        batchUuids,
      },
    });
    const [job] = repository.dequeue('message_delivery');
    return { jobId: job.id, claimToken: job.claimToken as string };
  };

  const payloadOf = (jobId: string): Record<string, unknown> =>
    JSON.parse(
      (db.prepare(`SELECT payload FROM job_queue WHERE id = ?`).get(jobId) as { payload: string })
        .payload
    ) as Record<string, unknown>;

  const statusOf = (uuid: string): string =>
    (
      db.prepare(`SELECT send_status AS s FROM sdk_messages WHERE sdk_uuid = ?`).get(uuid) as {
        s: string;
      }
    ).s;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
			CREATE TABLE job_queue (
				id TEXT PRIMARY KEY,
				queue TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
				payload TEXT NOT NULL DEFAULT '{}',
				result TEXT,
				error TEXT,
				priority INTEGER NOT NULL DEFAULT 0,
				max_retries INTEGER NOT NULL DEFAULT 3,
				retry_count INTEGER NOT NULL DEFAULT 0,
				run_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				heartbeat_at INTEGER,
				completed_at INTEGER
			);

			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT,
				sdk_uuid TEXT
			);
		`);
    repository = new JobQueueRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  it('flips only enqueued user rows under a live claim', () => {
    insertMessage('m1', 'enqueued');
    insertMessage('m2', 'submitted');
    insertMessage('m3', 'enqueued');
    insertMessage('m4', 'enqueued', 'assistant');
    const { claimToken } = claimDeliveryJob([KICKOFF]);
    const flipped = repository.transitionDeliverySendStatusFenced({
      sessionId: SESSION,
      kickoffUuid: KICKOFF,
      claimToken,
      uuids: ['m1', 'm2', 'm3', 'm4'],
      fromStatus: 'enqueued',
      toStatus: 'submitted',
    });
    expect([...flipped].sort()).toEqual(['m1', 'm3']);
    expect(statusOf('m2')).toBe('submitted');
    expect(statusOf('m4')).toBe('enqueued');
  });

  it('flips nothing when the claim is superseded', () => {
    insertMessage('m1', 'enqueued');
    claimDeliveryJob([KICKOFF]);
    const flipped = repository.transitionDeliverySendStatusFenced({
      sessionId: SESSION,
      kickoffUuid: KICKOFF,
      claimToken: 'superseded-claim',
      uuids: ['m1'],
      fromStatus: 'enqueued',
      toStatus: 'submitted',
    });
    expect(flipped).toEqual([]);
    expect(statusOf('m1')).toBe('enqueued');
  });

  it('restores only rows still submitted when compensating', () => {
    insertMessage('m1', 'enqueued');
    insertMessage('m2', 'enqueued');
    const { claimToken } = claimDeliveryJob([KICKOFF]);
    const flipped = repository.transitionDeliverySendStatusFenced({
      sessionId: SESSION,
      kickoffUuid: KICKOFF,
      claimToken,
      uuids: ['m1', 'm2'],
      fromStatus: 'enqueued',
      toStatus: 'submitted',
    });
    expect([...flipped].sort()).toEqual(['m1', 'm2']);
    db.prepare(`UPDATE sdk_messages SET send_status = 'consumed' WHERE sdk_uuid = 'm2'`).run();
    const restored = repository.transitionDeliverySendStatusFenced({
      sessionId: SESSION,
      kickoffUuid: KICKOFF,
      claimToken,
      uuids: flipped,
      fromStatus: 'submitted',
      toStatus: 'enqueued',
    });
    expect(restored).toEqual(['m1']);
    expect(statusOf('m1')).toBe('enqueued');
    expect(statusOf('m2')).toBe('consumed');
  });

  it('reserves admission once per uuid and reports the owning claim on retry', () => {
    const { jobId, claimToken } = claimDeliveryJob([KICKOFF]);
    const args = { sessionId: SESSION, kickoffUuid: KICKOFF, claimToken, messageUuid: KICKOFF };
    expect(repository.reserveDeliveryAdmission(args)).toEqual({ status: 'reserved' });
    expect(repository.reserveDeliveryAdmission(args)).toEqual({
      status: 'alreadyReserved',
      reservedByClaimToken: claimToken,
    });
    expect(payloadOf(jobId).__admissionReservations).toEqual({ [KICKOFF]: claimToken });
  });

  it('keeps the reservation durable across a crash replay under a new claim', () => {
    const { jobId, claimToken } = claimDeliveryJob([KICKOFF]);
    expect(
      repository.reserveDeliveryAdmission({
        sessionId: SESSION,
        kickoffUuid: KICKOFF,
        claimToken,
        messageUuid: KICKOFF,
      })
    ).toEqual({ status: 'reserved' });
    repository.requeue(jobId, Date.now() - 1000, claimToken);
    const [replay] = repository.dequeue('message_delivery');
    const replayToken = replay.claimToken as string;
    expect(replayToken).not.toBe(claimToken);
    expect(
      repository.reserveDeliveryAdmission({
        sessionId: SESSION,
        kickoffUuid: KICKOFF,
        claimToken: replayToken,
        messageUuid: KICKOFF,
      })
    ).toEqual({ status: 'alreadyReserved', reservedByClaimToken: claimToken });
  });

  it('reports a stale claim without writing a reservation', () => {
    const { jobId } = claimDeliveryJob([KICKOFF]);
    expect(
      repository.reserveDeliveryAdmission({
        sessionId: SESSION,
        kickoffUuid: KICKOFF,
        claimToken: 'superseded-claim',
        messageUuid: KICKOFF,
      })
    ).toEqual({ status: 'staleClaim' });
    expect(payloadOf(jobId).__admissionReservations).toBeUndefined();
  });
});
