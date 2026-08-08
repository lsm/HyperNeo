/**
 * Message delivery lifecycle — stranded-shape regression coverage (task #859)
 *
 * The confirmed stranded shape (task #856): a user message is persisted but the
 * session never delivers it — no wake acceptance, no SDK progress. These tests
 * prove the instrumented persistence chokepoint (Database.saveUserMessage)
 * records a `persisted` lifecycle event for EVERY delivery origin, and that a
 * message left at `persisted` is surfaced by the diagnostics as unclaimed and
 * identifiable by its stable UUID.
 *
 * Ordinary chat and Space/external-event delivery both flow through the same
 * Database.saveUserMessage chokepoint, so both origins are covered here.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { generateUUID } from '@hyperneo/shared';
import type { UUID } from 'crypto';
import { createTestDb, createTestSession } from '../../helpers/database';
import type { Database } from '../../../src/storage';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { LatestStageResult } from '../../../src/storage/repositories/message-delivery-lifecycle-repository';

let db: Database;
const SESSION_ID = 'sess-stranded-1';

// getLatestStage returns { ok, value }; these tests run on a healthy ledger, so
// unwrap value?.stage for the assertion.
function latestStageOf(
  repo: { getLatestStage: (messageId: string) => LatestStageResult },
  messageId: string
) {
  const result = repo.getLatestStage(messageId);
  return result.ok ? result.value?.stage : undefined;
}

function makeUserMessage(messageId: string, text: string, synthetic = false): SDKUserMessage {
  return {
    type: 'user',
    uuid: messageId as UUID,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    ...(synthetic ? { isSynthetic: true } : {}),
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SDKUserMessage;
}

beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession(SESSION_ID));
});

describe('stranded-shape regression: persistence chokepoint records every origin', () => {
  test('ordinary chat: a persisted-but-undelivered message is stranded and identifiable by UUID', () => {
    const messageId = generateUUID();
    // Ordinary chat path: persist via the shared Database.saveUserMessage
    // chokepoint (origin 'human'), then NEVER wake/accept/consume it.
    db.saveUserMessage(SESSION_ID, makeUserMessage(messageId, 'hello'), 'enqueued', 'human');

    // The message entered the lifecycle ledger at `persisted`.
    const timeline = db.messageDeliveryLifecycle.getTimeline(messageId);
    expect(timeline.map((e) => e.stage)).toEqual(['persisted']);
    expect(timeline[0].detail).toEqual({ sendStatus: 'enqueued', origin: 'human' });

    // Its latest (and only) stage is `persisted` — it stopped at persistence.
    expect(latestStageOf(db.messageDeliveryLifecycle, messageId)).toBe('persisted');

    // Diagnostics surfaces it as unclaimed (persisted, never accepted/consumed).
    const diag = db.messageDeliveryLifecycle.getDiagnostics({ sessionId: SESSION_ID });
    const stranded = diag.unclaimed.find((u) => u.messageId === messageId);
    expect(stranded).toBeTruthy();
    expect(stranded?.stage).toBe('persisted');
  });

  test('Space/external-event origin: the same shared chokepoint records persisted', () => {
    // Space node inject + external-event delivery persist with origin=null
    // (system) and isSynthetic=true, but go through the SAME saveUserMessage
    // call as ordinary chat. The chokepoint must record `persisted` regardless.
    const messageId = generateUUID();
    db.saveUserMessage(
      SESSION_ID,
      makeUserMessage(messageId, 'peer handoff', true),
      'enqueued',
      undefined
    );

    expect(db.messageDeliveryLifecycle.getTimeline(messageId).map((e) => e.stage)).toEqual([
      'persisted',
    ]);
    expect(latestStageOf(db.messageDeliveryLifecycle, messageId)).toBe('persisted');

    const diag = db.messageDeliveryLifecycle.getDiagnostics({ sessionId: SESSION_ID });
    expect(diag.unclaimed.some((u) => u.messageId === messageId)).toBe(true);
  });

  test('a fully delivered message is NOT flagged as stranded', () => {
    const strandedId = generateUUID();
    const deliveredId = generateUUID();

    // Stranded: persisted only.
    db.saveUserMessage(SESSION_ID, makeUserMessage(strandedId, 'lost'), 'enqueued', 'human');

    // Delivered: persisted, then progresses through to completion.
    db.saveUserMessage(SESSION_ID, makeUserMessage(deliveredId, 'delivered'), 'enqueued', 'human');
    const repo = db.messageDeliveryLifecycle;
    repo.record(SESSION_ID, deliveredId, 'accepted');
    repo.record(SESSION_ID, deliveredId, 'consumed');
    repo.record(SESSION_ID, deliveredId, 'first_progress');
    repo.record(SESSION_ID, deliveredId, 'completed');

    const diag = repo.getDiagnostics({ sessionId: SESSION_ID });
    const unclaimedIds = diag.unclaimed.map((u) => u.messageId);
    expect(unclaimedIds).toContain(strandedId);
    expect(unclaimedIds).not.toContain(deliveredId);
    expect(latestStageOf(repo, deliveredId)).toBe('completed');
  });

  test('timeline answers "where did this message stop?" across the full happy path', () => {
    const messageId = generateUUID();
    db.saveUserMessage(SESSION_ID, makeUserMessage(messageId, 'hi'), 'enqueued', 'human');
    const repo = db.messageDeliveryLifecycle;
    repo.record(SESSION_ID, messageId, 'wake_requested', { queryStart: 'started' });
    repo.record(SESSION_ID, messageId, 'accepted');
    repo.record(SESSION_ID, messageId, 'consumed');
    repo.record(SESSION_ID, messageId, 'first_progress');
    repo.record(SESSION_ID, messageId, 'completed', { success: true });

    const stages = repo.getTimeline(messageId).map((e) => e.stage);
    expect(stages).toEqual([
      'persisted',
      'wake_requested',
      'accepted',
      'consumed',
      'first_progress',
      'completed',
    ]);
  });

  test('cancelling a pending message clears its lifecycle rows (F3)', () => {
    const messageId = generateUUID();
    const dbId = db.saveUserMessage(
      SESSION_ID,
      makeUserMessage(messageId, 'never mind'),
      'enqueued',
      'human'
    );
    const repo = db.messageDeliveryLifecycle;
    expect(latestStageOf(repo, messageId)).toBe('persisted');
    expect(
      repo
        .getDiagnostics({ sessionId: SESSION_ID })
        .unclaimed.some((u) => u.messageId === messageId)
    ).toBe(true);

    // User intentionally removes the pending message.
    const removed = db.deletePendingUserMessage(SESSION_ID, dbId);
    expect(removed?.uuid).toBe(messageId);

    // Ledger rows are gone — no longer falsely reported as unclaimed/stranded.
    expect(repo.getTimeline(messageId)).toEqual([]);
    expect(
      repo
        .getDiagnostics({ sessionId: SESSION_ID })
        .unclaimed.some((u) => u.messageId === messageId)
    ).toBe(false);
  });

  test('deferring a message re-records the persisted marker (round-19)', () => {
    const messageId = generateUUID();
    db.saveUserMessage(SESSION_ID, makeUserMessage(messageId, 'later'), 'enqueued', 'human');
    const repo = db.messageDeliveryLifecycle;
    repo.record(SESSION_ID, messageId, 'accepted');

    // deferPending: clear the obsolete accepted attempt, then re-record the
    // persisted/deferred marker so the durable row's timeline isn't empty and
    // diagnostics still excludes it as intentionally-deferred.
    repo.deleteForMessage(messageId);
    repo.record(SESSION_ID, messageId, 'persisted', { sendStatus: 'deferred' });

    expect(repo.getTimeline(messageId).map((e) => e.stage)).toEqual(['persisted']);
    const diag = repo.getDiagnostics({ sessionId: SESSION_ID });
    expect(diag.unclaimed.some((u) => u.messageId === messageId)).toBe(false);
    expect(diag.stale.some((s) => s.messageId === messageId)).toBe(false);
  });

  test('rewinding the conversation clears lifecycle rows for deleted messages (N9)', () => {
    const messageId = generateUUID();
    db.saveUserMessage(SESSION_ID, makeUserMessage(messageId, 'rewind me'), 'enqueued', 'human');
    const repo = db.messageDeliveryLifecycle;
    repo.record(SESSION_ID, messageId, 'accepted');
    expect(latestStageOf(repo, messageId)).toBe('accepted');

    // Rewind deletes the sdk_messages row at/after its timestamp; the facade
    // also clears the lifecycle rows so diagnostics stops tracking it.
    const deleted = db.deleteMessagesAtAndAfter(SESSION_ID, Date.now() - 1000);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(latestStageOf(repo, messageId)).toBeUndefined();
    expect(
      repo
        .getDiagnostics({ sessionId: SESSION_ID })
        .unclaimed.some((u) => u.messageId === messageId)
    ).toBe(false);
  });
});
