import { describe, expect, it } from 'bun:test';
import type { ExternalEventEssenceEntry } from '../../../../src/lib/external-events/deferred-event-digest';
import {
  runDirectSteerFlush,
  type DirectSteerBufferEntry,
  type DirectSteerFlushDeps,
  type DirectSteerFlushInput,
  type DirectSteerFlushOutcome,
} from '../../../../src/lib/space/runtime/direct-steer-flush-pipeline';

const SESSION_ID = 'session-flush';
const SNIPPET_MAX_CHARS = 2000;

function reviewCommentEssence(eventId: string): ExternalEventEssenceEntry {
  return {
    eventId,
    topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
    eventType: 'pull_request_review_comment',
    action: 'polled',
    actor: 'codex[bot]',
    body: 'Consider handling this case.',
    commentId: `c-${eventId}`,
  };
}

function humanCommentEssence(eventId: string): ExternalEventEssenceEntry {
  return {
    eventId,
    topic: 'github/lsm/hyperneo/pull_request/2828.comment_polled',
    eventType: 'issue_comment',
    action: 'polled',
    actor: 'lsm',
    body: 'HUMAN_NOTE',
    commentId: `c-${eventId}`,
  };
}

function checkFailedEssence(eventId: string): ExternalEventEssenceEntry {
  return {
    eventId,
    topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
    eventType: 'check_run',
    action: 'failed',
    actor: 'github-actions[bot]',
    checkName: 'Lint',
    conclusion: 'failure',
  };
}

function input(overrides: Partial<DirectSteerFlushInput> = {}): DirectSteerFlushInput {
  return {
    sessionId: SESSION_ID,
    entries: [],
    snippetMaxChars: SNIPPET_MAX_CHARS,
    ...overrides,
  };
}

function entry(
  messageId: string,
  dbId: string,
  essences: ExternalEventEssenceEntry[]
): DirectSteerBufferEntry {
  return { messageId, dbId, essences, receivedAt: Date.now() };
}

function makeDeps(overrides: Partial<DirectSteerFlushDeps> = {}): DirectSteerFlushDeps {
  return {
    getSessionTracked: () => true,
    getSessionProcessing: () => true,
    isParentTaskLimited: () => false,
    getDeferredUuids: () => new Set<string>(),
    savePassenger: () => 'passenger-db-1',
    discardPassenger: () => Promise.resolve(),
    saveSteer: () => 'steer-db-1',
    discardSteer: () => Promise.resolve(),
    enqueueSteer: () => {},
    consumeSources: () => {},
    recordHealthMetrics: () => {},
    publishStatusChanged: () => Promise.resolve(),
    publishStatusesChanged: () => Promise.resolve(),
    ...overrides,
  };
}

async function flush(
  entries: DirectSteerBufferEntry[],
  depsOverrides: Partial<DirectSteerFlushDeps> = {}
): Promise<DirectSteerFlushOutcome> {
  return runDirectSteerFlush(makeDeps(depsOverrides), input({ entries }));
}

describe('direct-steer flush pipeline', () => {
  it('delivers a single direct-class event', async () => {
    const essence = reviewCommentEssence('rc-1');
    const e = entry('msg-1', 'db-1', [essence]);
    const outcome = await flush([e], { getDeferredUuids: () => new Set(['msg-1']) });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.steerableCount).toBe(1);
    expect(outcome.eventCount).toBe(1);
    expect(outcome.passengerCount).toBe(0);
    expect(outcome.passengerText).toBeNull();
    expect(outcome.sourceDbIds).toEqual(['db-1']);
    expect(outcome.steerText).toContain('injected mid-turn');
    expect(outcome.steerText).toContain('c-rc-1');
    expect(outcome.steeredClasses).toEqual(['review']);
  });

  it('coalesces multiple direct-class events into one steer', async () => {
    const essences = [reviewCommentEssence('rc-1'), reviewCommentEssence('rc-2')];
    const e = entry('msg-1', 'db-1', essences);
    const outcome = await flush([e], { getDeferredUuids: () => new Set(['msg-1']) });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.eventCount).toBe(2);
    expect(outcome.steerableCount).toBe(1);
    expect(outcome.steerText).toContain('c-rc-1');
    expect(outcome.steerText).toContain('c-rc-2');
  });

  it('re-deferred passengers alongside a mixed steer', async () => {
    const essences = [reviewCommentEssence('rc-1'), humanCommentEssence('human-1')];
    const e = entry('msg-1', 'db-1', essences);
    const savedPassengers: Array<{ sessionId: string; message: unknown }> = [];
    const outcome = await flush([e], {
      getDeferredUuids: () => new Set(['msg-1']),
      savePassenger: (sessionId, message) => {
        savedPassengers.push({ sessionId, message });
        return 'passenger-db-1';
      },
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.eventCount).toBe(1);
    expect(outcome.passengerCount).toBe(1);
    expect(outcome.passengerText).not.toBeNull();
    expect(outcome.passengerText).toContain('HUMAN_NOTE');
    expect(outcome.steerText).not.toContain('HUMAN_NOTE');
    expect(savedPassengers.length).toBe(1);
    expect(savedPassengers[0].sessionId).toBe(SESSION_ID);
  });

  it('skips when the session is no longer tracked', async () => {
    const outcome = await flush([], { getSessionTracked: () => false });
    expect(outcome).toEqual({ action: 'skip', reason: 'session_not_tracked' });
  });

  it('skips when the session is not processing', async () => {
    const outcome = await flush([], { getSessionProcessing: () => false });
    expect(outcome).toEqual({ action: 'skip', reason: 'session_not_processing' });
  });

  it('skips when the parent task is limited', async () => {
    const e = entry('msg-1', 'db-1', [reviewCommentEssence('rc-1')]);
    const outcome = await flush([e], {
      getDeferredUuids: () => new Set(['msg-1']),
      isParentTaskLimited: () => true,
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'parent_task_limited' });
  });

  it('skips when none of the buffered rows are still deferred', async () => {
    const e = entry('msg-1', 'db-1', [reviewCommentEssence('rc-1')]);
    const outcome = await flush([e], { getDeferredUuids: () => new Set(['other-uuid']) });
    expect(outcome).toEqual({ action: 'skip', reason: 'no_deferred_rows' });
  });

  it('skips when no direct-class events remain after filtering', async () => {
    const e = entry('msg-1', 'db-1', [humanCommentEssence('human-1')]);
    const outcome = await flush([e], { getDeferredUuids: () => new Set(['msg-1']) });
    expect(outcome).toEqual({ action: 'skip', reason: 'no_direct_events' });
  });

  it('carries a fold omission count into an all-direct steer', async () => {
    const essences = [reviewCommentEssence('rc-1')];
    const e = entry('msg-1', 'db-1', essences);
    e.droppedEventCount = 5;
    const outcome = await flush([e], { getDeferredUuids: () => new Set(['msg-1']) });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.carriedDropped).toBe(5);
    expect(outcome.steerText).toContain('5 older events were omitted');
  });

  it('carries a fold omission count into a passenger remainder', async () => {
    const essences = [reviewCommentEssence('rc-1'), humanCommentEssence('human-1')];
    const e = entry('msg-1', 'db-1', essences);
    e.droppedEventCount = 3;
    const outcome = await flush([e], { getDeferredUuids: () => new Set(['msg-1']) });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(outcome.carriedDropped).toBe(3);
    expect(outcome.passengerText).toContain('3');
    expect(outcome.steerText).not.toContain('older events were omitted');
  });

  it('reports every represented direct class', async () => {
    const essences = [reviewCommentEssence('rc-1'), checkFailedEssence('chk-1')];
    const e = entry('msg-1', 'db-1', essences);
    const outcome = await flush([e], { getDeferredUuids: () => new Set(['msg-1']) });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(new Set(outcome.steeredClasses)).toEqual(new Set(['review', 'check']));
  });

  it('consumes sources, records metrics, and publishes status on delivery', async () => {
    const essences = [reviewCommentEssence('rc-1')];
    const e = entry('msg-1', 'db-1', essences);
    const consumed: string[][] = [];
    const publishedSingle: Array<{ sessionId: string; dbId: string; status: string }> = [];
    const publishedMulti: Array<{ sessionId: string; dbIds: string[]; status: string }> = [];
    const recorded: string[][] = [];
    const outcome = await flush([e], {
      getDeferredUuids: () => new Set(['msg-1']),
      consumeSources: (_sessionId, dbIds) => consumed.push(dbIds),
      recordHealthMetrics: (classes) => recorded.push(classes),
      publishStatusChanged: (sessionId, dbId, status) => {
        publishedSingle.push({ sessionId, dbId, status });
        return Promise.resolve();
      },
      publishStatusesChanged: (sessionId, dbIds, status) => {
        publishedMulti.push({ sessionId, dbIds, status });
        return Promise.resolve();
      },
    });
    expect(outcome.action).toBe('delivered');
    if (outcome.action !== 'delivered') return;
    expect(consumed).toEqual([['db-1']]);
    expect(recorded).toEqual([['review']]);
    expect(publishedSingle).toEqual([
      { sessionId: SESSION_ID, dbId: 'steer-db-1', status: 'enqueued' },
    ]);
    expect(publishedMulti).toEqual([
      { sessionId: SESSION_ID, dbIds: ['db-1'], status: 'consumed' },
    ]);
  });

  it('discards a saved passenger and skips when the session leaves processing', async () => {
    const essences = [reviewCommentEssence('rc-1'), humanCommentEssence('human-1')];
    const e = entry('msg-1', 'db-1', essences);
    const discarded: Array<{ sessionId: string; dbId: string | null }> = [];
    let processingAfterSave = true;
    const outcome = await flush([e], {
      getDeferredUuids: () => new Set(['msg-1']),
      savePassenger: () => 'passenger-db-1',
      discardPassenger: (sessionId, dbId) => {
        discarded.push({ sessionId, dbId });
        return Promise.resolve();
      },
      getSessionProcessing: () => {
        const result = processingAfterSave;
        processingAfterSave = false;
        return result;
      },
    });
    expect(outcome.action).toBe('skip');
    expect(outcome).toEqual({ action: 'skip', reason: 'session_not_processing' });
    expect(discarded).toEqual([{ sessionId: SESSION_ID, dbId: 'passenger-db-1' }]);
  });

  it('fails and discards a saved passenger when steer persistence fails', async () => {
    const essences = [reviewCommentEssence('rc-1'), humanCommentEssence('human-1')];
    const e = entry('msg-1', 'db-1', essences);
    const discarded: Array<{ sessionId: string; dbId: string | null }> = [];
    const outcome = await flush([e], {
      getDeferredUuids: () => new Set(['msg-1']),
      savePassenger: () => 'passenger-db-1',
      discardPassenger: (sessionId, dbId) => {
        discarded.push({ sessionId, dbId });
        return Promise.resolve();
      },
      saveSteer: () => {
        throw new Error('db locked');
      },
    });
    expect(outcome.action).toBe('failed');
    if (outcome.action !== 'failed') return;
    expect(outcome.stage).toBe('persistSteer');
    expect(discarded).toEqual([{ sessionId: SESSION_ID, dbId: 'passenger-db-1' }]);
  });

  it('skips and rolls back the saved steer when the session leaves processing right before enqueue', async () => {
    const essences = [reviewCommentEssence('rc-1'), humanCommentEssence('human-1')];
    const e = entry('msg-1', 'db-1', essences);
    const processingCalls = [true, true, false];
    const discardedPassengers: Array<string | null> = [];
    const discardedSteers: string[] = [];
    let enqueued = 0;
    const outcome = await flush([e], {
      getDeferredUuids: () => new Set(['msg-1']),
      savePassenger: () => 'passenger-db-1',
      getSessionProcessing: () => processingCalls.shift() ?? false,
      discardPassenger: (_sessionId, dbId) => {
        discardedPassengers.push(dbId);
        return Promise.resolve();
      },
      discardSteer: (_sessionId, messageId) => {
        discardedSteers.push(messageId);
        return Promise.resolve();
      },
      enqueueSteer: () => {
        enqueued += 1;
      },
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'session_not_processing' });
    expect(discardedPassengers).toEqual(['passenger-db-1']);
    expect(discardedSteers.length).toBe(1);
    expect(enqueued).toBe(0);
  });

  it('skips and rolls back the saved steer when the parent task becomes limited right before enqueue', async () => {
    const essences = [reviewCommentEssence('rc-1'), humanCommentEssence('human-1')];
    const e = entry('msg-1', 'db-1', essences);
    const limitedCalls = [false, false, true];
    const discardedPassengers: Array<string | null> = [];
    const discardedSteers: string[] = [];
    let enqueued = 0;
    const outcome = await flush([e], {
      getDeferredUuids: () => new Set(['msg-1']),
      savePassenger: () => 'passenger-db-1',
      isParentTaskLimited: () => limitedCalls.shift() ?? false,
      discardPassenger: (_sessionId, dbId) => {
        discardedPassengers.push(dbId);
        return Promise.resolve();
      },
      discardSteer: (_sessionId, messageId) => {
        discardedSteers.push(messageId);
        return Promise.resolve();
      },
      enqueueSteer: () => {
        enqueued += 1;
      },
    });
    expect(outcome).toEqual({ action: 'skip', reason: 'parent_task_limited' });
    expect(discardedPassengers).toEqual(['passenger-db-1']);
    expect(discardedSteers.length).toBe(1);
    expect(enqueued).toBe(0);
  });
});
