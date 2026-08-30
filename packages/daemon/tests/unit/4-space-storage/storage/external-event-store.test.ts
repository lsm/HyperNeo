import { Database } from '../../../../src/storage/sqlite-compat';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ExternalEventStore,
  ExternalEventValidationError,
} from '../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createSpaceTables } from '../../helpers/space-test-db';

let db: Database;
let store: ExternalEventStore;

const SPACE_ID = 'sp-evt';
const EVENT_A: ExternalEvent = {
  id: 'evt-a',
  spaceId: SPACE_ID,
  source: 'github',
  topic: 'github/lsm/neokai/pull_request/42.review_submitted',
  occurredAt: 1_700_000_000_000,
  ingestedAt: 1_700_000_001_000,
  dedupeKey: 'github:pr:42:review_submitted:12345',
  summary: 'PR #42 review submitted',
  payload: {
    action: 'review_submitted',
    review_id: 12345,
    prNumber: 42,
    repoOwner: 'lsm',
    repoName: 'neokai',
  },
};

const EVENT_B: ExternalEvent = {
  id: 'evt-b',
  spaceId: SPACE_ID,
  source: 'github',
  topic: 'github/lsm/neokai/pull_request/99.opened',
  occurredAt: 1_700_000_100_000,
  ingestedAt: 1_700_000_101_000,
  dedupeKey: 'github:pr:99:opened',
  summary: 'PR #99 opened',
  payload: { action: 'opened', number: 99 },
};

function freshDb(): Database {
  const d = new Database(':memory:');
  createSpaceTables(d);
  const now = Date.now();
  d.exec(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('${SPACE_ID}', '${SPACE_ID}', '/tmp/test', 'Test Space', ${now}, ${now})`
  );
  return d;
}

beforeEach(() => {
  db = freshDb();
  store = new ExternalEventStore(db);
});

describe('store — first observation', () => {
  test('inserts a new row and returns duplicate=false, terminal=false', () => {
    const result = store.store(EVENT_A);
    expect(result.duplicate).toBe(false);
    expect(result.terminal).toBe(false);
    expect(result.event.id).toBe('evt-a');

    const rec = store.getById('evt-a');
    expect(rec).not.toBeNull();
    expect(rec!.state).toBe('published');
    expect(rec!.event.spaceId).toBe(SPACE_ID);
    expect(rec!.event.topic).toBe(EVENT_A.topic);
    expect(rec!.event.dedupeKey).toBe(EVENT_A.dedupeKey);
    expect(rec!.event.payload).toEqual(EVENT_A.payload);
  });

  test('stores optional fields when present', () => {
    const event: ExternalEvent = {
      ...EVENT_A,
      sourceEventId: 'del-123',
      externalUrl: 'https://github.com/lsm/neokai/pull/42',
    };
    store.store(event);
    const rec = store.getById('evt-a');
    expect(rec!.event.sourceEventId).toBe('del-123');
    expect(rec!.event.externalUrl).toBe('https://github.com/lsm/neokai/pull/42');
    expect(rec!.event.payload.prNumber).toBe(42);
    expect(rec!.event.payload.repoOwner).toBe('lsm');
    expect(rec!.event.payload.repoName).toBe('neokai');
  });

  test('getByDedupe returns the canonical row', () => {
    store.store(EVENT_A);
    const rec = store.getByDedupe(SPACE_ID, 'github', EVENT_A.dedupeKey);
    expect(rec).not.toBeNull();
    expect(rec!.event.id).toBe('evt-a');
  });
});

describe('store — duplicate handling', () => {
  test('terminal duplicate short-circuits (delivered)', () => {
    store.store(EVENT_A);
    store.markEventIgnored('evt-a', 'no_matching_subscriptions');

    const dup = store.store({ ...EVENT_A, id: 'evt-a-dup' });
    expect(dup.duplicate).toBe(true);
    expect(dup.terminal).toBe(true);
    expect(dup.event.id).toBe('evt-a');
  });

  test('terminal duplicate short-circuits (failed)', () => {
    store.store(EVENT_A);
    store.markEventFailed('evt-a', { terminal: true, reason: 'enrichment error' });

    const dup = store.store({ ...EVENT_A, id: 'evt-a-dup' });
    expect(dup.duplicate).toBe(true);
    expect(dup.terminal).toBe(true);
  });

  test('retryable duplicate re-emits (published)', () => {
    store.store(EVENT_A);

    const dup = store.store({ ...EVENT_A, id: 'evt-a-dup' });
    expect(dup.duplicate).toBe(true);
    expect(dup.terminal).toBe(false);
    expect(dup.event.id).toBe('evt-a');
  });
});

describe('store — validation', () => {
  test('rejects missing id', () => {
    expect(() => store.store({ ...EVENT_A, id: '' })).toThrow(ExternalEventValidationError);
  });

  test('rejects missing spaceId', () => {
    expect(() => store.store({ ...EVENT_A, spaceId: '' })).toThrow(ExternalEventValidationError);
  });

  test('rejects missing dedupeKey', () => {
    expect(() => store.store({ ...EVENT_A, dedupeKey: '' })).toThrow(ExternalEventValidationError);
  });

  test('rejects whitespace-only dedupeKey', () => {
    expect(() => store.store({ ...EVENT_A, dedupeKey: '   ' })).toThrow(
      ExternalEventValidationError
    );
  });

  test('rejects dedupeKey with leading/trailing whitespace', () => {
    expect(() => store.store({ ...EVENT_A, dedupeKey: ' key' })).toThrow(
      ExternalEventValidationError
    );
    expect(() => store.store({ ...EVENT_A, dedupeKey: 'key ' })).toThrow(
      ExternalEventValidationError
    );
  });

  test('rejects unknown source', () => {
    expect(() => store.store({ ...EVENT_A, source: 'slack' })).toThrow(
      ExternalEventValidationError
    );
  });

  test('rejects topic with only one segment', () => {
    expect(() => store.store({ ...EVENT_A, topic: 'github' })).toThrow(
      ExternalEventValidationError
    );
  });

  test('rejects topic whose first segment does not match source', () => {
    expect(() =>
      store.store({ ...EVENT_A, topic: 'slack/owner/repo/pull_request.opened' })
    ).toThrow(ExternalEventValidationError);
  });

  test('rejects wildcard topic on store', () => {
    expect(() => store.store({ ...EVENT_A, topic: 'github/*/*/pull_request/*.opened' })).toThrow(
      'no wildcards'
    );
  });

  test('rejects dotted wildcard topic on store', () => {
    expect(() => store.store({ ...EVENT_A, topic: 'github/lsm/neokai/pull_request/*.*' })).toThrow(
      'no wildcards'
    );
  });

  test('rejects non-finite occurredAt', () => {
    expect(() => store.store({ ...EVENT_A, occurredAt: NaN })).toThrow(
      ExternalEventValidationError
    );
  });

  test('rejects non-finite ingestedAt', () => {
    expect(() => store.store({ ...EVENT_A, ingestedAt: Infinity })).toThrow(
      ExternalEventValidationError
    );
  });

  test('rejects non-string summary', () => {
    expect(() => store.store({ ...EVENT_A, summary: 123 as unknown as string })).toThrow(
      ExternalEventValidationError
    );
  });

  test('rejects null payload', () => {
    expect(() =>
      store.store({ ...EVENT_A, payload: null as unknown as Record<string, unknown> })
    ).toThrow(ExternalEventValidationError);
  });
});

describe('registerExpectedDelivery', () => {
  test('inserts a pending row for a new delivery key', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });

    const deliveries = store.listDeliveries('evt-a');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.state).toBe('pending');
    expect(deliveries[0]!.workflowRunId).toBe('run-1');
  });

  test('lists delivery log rows with source event metadata and filters', () => {
    store.store(EVENT_A);
    store.store(EVENT_B);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-b', 'dk-2', {
      workflowRunId: 'run-2',
      taskId: 'task-2',
      nodeId: 'node-2',
      agentName: 'reviewer',
    });
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'agent missing' });

    const failed = store.listDeliveryLog({ spaceId: SPACE_ID, status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.eventId).toBe('evt-a');
    expect(failed[0]!.event.topic).toBe(EVENT_A.topic);
    expect(failed[0]!.event.payload).toEqual(EVENT_A.payload);
    expect(failed[0]!.eventState).toBe('published');
    expect(failed[0]!.failureReason).toBe('agent missing');

    const reviewer = store.listDeliveryLog({ spaceId: SPACE_ID, agentName: 'reviewer' });
    expect(reviewer).toHaveLength(1);
    expect(reviewer[0]!.eventId).toBe('evt-b');
  });

  test('listDeliveryLog filters by workflowRunId and nodeId (the run/node join)', () => {
    store.store(EVENT_A);
    store.store(EVENT_B);
    store.registerExpectedDelivery('evt-a', 'dk-run1-coder', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-coder',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-run1-reviewer', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-reviewer',
      agentName: 'reviewer',
    });
    store.registerExpectedDelivery('evt-b', 'dk-run2', {
      workflowRunId: 'run-2',
      taskId: 'task-2',
      nodeId: 'node-coder',
      agentName: 'coder',
    });

    const run1 = store.listDeliveryLog({ spaceId: SPACE_ID, workflowRunId: 'run-1' });
    expect(run1).toHaveLength(2);
    expect(new Set(run1.map((d) => d.deliveryKey))).toEqual(
      new Set(['dk-run1-coder', 'dk-run1-reviewer'])
    );

    const run1Coder = store.listDeliveryLog({
      spaceId: SPACE_ID,
      workflowRunId: 'run-1',
      nodeId: 'node-coder',
    });
    expect(run1Coder).toHaveLength(1);
    expect(run1Coder[0]!.deliveryKey).toBe('dk-run1-coder');
    expect(run1Coder[0]!.event.topic).toBe(EVENT_A.topic);

    const coderAll = store.listDeliveryLog({ spaceId: SPACE_ID, nodeId: 'node-coder' });
    expect(coderAll).toHaveLength(2);

    const run2 = store.listDeliveryLog({ spaceId: SPACE_ID, workflowRunId: 'run-2' });
    expect(run2).toHaveLength(1);
    expect(run2[0]!.deliveryKey).toBe('dk-run2');
  });

  test('listDeliveryLog combines workflowRunId + state filters', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-pending', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-delivered', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-2',
      agentName: 'reviewer',
    });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-delivered');

    const pending = store.listDeliveryLog({
      spaceId: SPACE_ID,
      workflowRunId: 'run-1',
      status: 'pending',
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.deliveryKey).toBe('dk-pending');

    const delivered = store.listDeliveryLog({
      spaceId: SPACE_ID,
      workflowRunId: 'run-1',
      status: 'delivered',
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.deliveryKey).toBe('dk-delivered');
  });

  test('is idempotent for duplicate registration', () => {
    store.store(EVENT_A);
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    store.registerExpectedDelivery('evt-a', 'dk-1', target);
    store.registerExpectedDelivery('evt-a', 'dk-1', target);

    const deliveries = store.listDeliveries('evt-a');
    expect(deliveries).toHaveLength(1);
  });

  test('reports whether the registration inserted a new row', () => {
    store.store(EVENT_A);
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    expect(store.registerExpectedDelivery('evt-a', 'dk-1', target)).toBe(true);
    expect(store.registerExpectedDelivery('evt-a', 'dk-1', target)).toBe(false);

    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    expect(store.registerExpectedDelivery('evt-a', 'dk-1', target)).toBe(false);
  });

  test('preserves terminal state on duplicate registration', () => {
    store.store(EVENT_A);
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    store.registerExpectedDelivery('evt-a', 'dk-1', target);
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    store.registerExpectedDelivery('evt-a', 'dk-1', target);

    const d = store.getDelivery('evt-a', 'dk-1');
    expect(d!.state).toBe('delivered');
  });

  test('throws for unknown event id', () => {
    expect(() =>
      store.registerExpectedDelivery('no-such-event', 'dk-1', {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('unknown source event id');
  });

  test('throws for empty deliveryKey', () => {
    store.store(EVENT_A);
    expect(() =>
      store.registerExpectedDelivery('evt-a', '', {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('deliveryKey must be non-empty');
  });

  test('throws for whitespace-only deliveryKey', () => {
    store.store(EVENT_A);
    expect(() =>
      store.registerExpectedDelivery('evt-a', '   ', {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('deliveryKey must be non-empty');
  });

  test('throws for empty workflowRunId', () => {
    store.store(EVENT_A);
    expect(() =>
      store.registerExpectedDelivery('evt-a', 'dk-1', {
        workflowRunId: '',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('workflowRunId must be non-empty');
  });

  test('throws for whitespace-only taskId', () => {
    store.store(EVENT_A);
    expect(() =>
      store.registerExpectedDelivery('evt-a', 'dk-1', {
        workflowRunId: 'run-1',
        taskId: '   ',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('taskId must be non-empty');
  });

  test('throws for empty nodeId', () => {
    store.store(EVENT_A);
    expect(() =>
      store.registerExpectedDelivery('evt-a', 'dk-1', {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        nodeId: '',
        agentName: 'coder',
      })
    ).toThrow('nodeId must be non-empty');
  });

  test('throws for empty agentName', () => {
    store.store(EVENT_A);
    expect(() =>
      store.registerExpectedDelivery('evt-a', 'dk-1', {
        workflowRunId: 'run-1',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: '',
      })
    ).toThrow('agentName must be non-empty');
  });

  test('throws for whitespace-padded workflowRunId', () => {
    store.store(EVENT_A);
    expect(() =>
      store.registerExpectedDelivery('evt-a', 'dk-1', {
        workflowRunId: 'run-1 ',
        taskId: 'task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('leading or trailing whitespace');
  });

  test('throws for whitespace-padded taskId', () => {
    store.store(EVENT_A);
    expect(() =>
      store.registerExpectedDelivery('evt-a', 'dk-1', {
        workflowRunId: 'run-1',
        taskId: ' task-1',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('leading or trailing whitespace');
  });

  test('throws for same-event delivery key with different target', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    expect(() =>
      store.registerExpectedDelivery('evt-a', 'dk-1', {
        workflowRunId: 'run-1',
        taskId: 'task-2',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('already registered for event "evt-a" with different target');
  });

  test('throws for cross-event delivery key conflict', () => {
    store.store(EVENT_A);
    store.store(EVENT_B);
    store.registerExpectedDelivery('evt-a', 'dk-shared', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    expect(() =>
      store.registerExpectedDelivery('evt-b', 'dk-shared', {
        workflowRunId: 'run-1',
        taskId: 'task-2',
        nodeId: 'node-1',
        agentName: 'coder',
      })
    ).toThrow('already registered for event "evt-a"');
  });
});

describe('isDeliveryTerminal', () => {
  test('returns false for pending', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    expect(store.isDeliveryTerminal('evt-a', 'dk-1')).toBe(false);
  });

  test('returns true for delivered', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    expect(store.isDeliveryTerminal('evt-a', 'dk-1')).toBe(true);
  });

  test('returns true for failed', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'node cancelled' });
    expect(store.isDeliveryTerminal('evt-a', 'dk-1')).toBe(true);
  });

  test('returns false for non-existent delivery', () => {
    expect(store.isDeliveryTerminal('evt-a', 'dk-none')).toBe(false);
  });
});

describe('getEventIdForDeliveryKey', () => {
  test('returns event id for a registered delivery key', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    expect(store.getEventIdForDeliveryKey('dk-1')).toBe('evt-a');
  });

  test('throws for unknown delivery key', () => {
    expect(() => store.getEventIdForDeliveryKey('dk-none')).toThrow('no delivery row');
  });
});

describe('markDeliveryMailboxAccepted', () => {
  test('advances pending → delivered', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    const d = store.getDelivery('evt-a', 'dk-1');
    expect(d!.state).toBe('delivered');
    expect(d!.deliveredAt).not.toBeNull();
  });

  test('no-op when already delivered', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    const before = store.getDelivery('evt-a', 'dk-1')!;
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    const after = store.getDelivery('evt-a', 'dk-1')!;
    expect(after.deliveredAt).toBe(before.deliveredAt);
  });

  test('no-op when already failed', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'boom' });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    const d = store.getDelivery('evt-a', 'dk-1');
    expect(d!.state).toBe('failed');
  });
});

describe('markDeliveriesDeliveredAtomic', () => {
  test('applies all changed marks and emits one hook per changed delivery', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-2', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    const hookCalls: Array<{ eventId: string; deliveryKey: string }> = [];
    store.setDeliveryTerminalHook((event) => {
      hookCalls.push({ eventId: event.eventId, deliveryKey: event.deliveryKey });
    });
    store.markDeliveriesDeliveredAtomic([
      { eventId: 'evt-a', deliveryKey: 'dk-1' },
      { eventId: 'evt-a', deliveryKey: 'dk-2' },
      { eventId: 'evt-a', deliveryKey: 'dk-none' },
    ]);
    expect(store.getDelivery('evt-a', 'dk-1')!.state).toBe('delivered');
    expect(store.getDelivery('evt-a', 'dk-2')!.state).toBe('delivered');
    expect(hookCalls).toEqual([
      { eventId: 'evt-a', deliveryKey: 'dk-1' },
      { eventId: 'evt-a', deliveryKey: 'dk-2' },
    ]);
  });

  test('re-running completed marks changes nothing and emits nothing', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveriesDeliveredAtomic([{ eventId: 'evt-a', deliveryKey: 'dk-1' }]);
    const before = store.getDelivery('evt-a', 'dk-1')!;
    const hookCalls: Array<{ eventId: string; deliveryKey: string }> = [];
    store.setDeliveryTerminalHook((event) => {
      hookCalls.push({ eventId: event.eventId, deliveryKey: event.deliveryKey });
    });
    store.markDeliveriesDeliveredAtomic([{ eventId: 'evt-a', deliveryKey: 'dk-1' }]);
    const after = store.getDelivery('evt-a', 'dk-1')!;
    expect(after.deliveredAt).toBe(before.deliveredAt);
    expect(hookCalls).toEqual([]);
  });
});

describe('markDeliveryFailed', () => {
  test('terminal failure advances pending → failed', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'node cancelled' });
    const d = store.getDelivery('evt-a', 'dk-1');
    expect(d!.state).toBe('failed');
    expect(d!.failureReason).toBe('node cancelled');
  });

  test('transient failure keeps row pending and records reason', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: false, reason: 'agent not ready' });
    const d = store.getDelivery('evt-a', 'dk-1');
    expect(d!.state).toBe('pending');
    expect(d!.failureReason).toBe('agent not ready');
  });

  test('no-op when already terminal', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'first' });
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'second' });
    const d = store.getDelivery('evt-a', 'dk-1');
    expect(d!.failureReason).toBe('first');
  });
});

describe('markPendingDeliveriesFailedBefore', () => {
  const TARGET = {
    workflowRunId: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-1',
    agentName: 'coder',
  };

  function ageEvent(eventId: string, createdAt: number): void {
    db.prepare('UPDATE space_external_events SET created_at = ? WHERE id = ?').run(
      createdAt,
      eventId
    );
  }

  test('expires pending deliveries on events past the cutoff and rolls up the event', () => {
    const hookCalls: Array<{ eventId: string; deliveryKey: string; reason: string | null }> = [];
    store.setDeliveryTerminalHook((event) =>
      hookCalls.push({
        eventId: event.eventId,
        deliveryKey: event.deliveryKey,
        reason: event.reason,
      })
    );
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', TARGET);
    store.registerExpectedDelivery('evt-a', 'dk-2', TARGET);
    store.registerExpectedDelivery('evt-a', 'dk-3', TARGET);
    store.markDeliveryMailboxAccepted('evt-a', 'dk-3');
    hookCalls.length = 0;

    const now = Date.now();
    ageEvent('evt-a', now - 400_000);

    const expired = store.markPendingDeliveriesFailedBefore(now - 300_000, new Set(), now);

    expect(expired).toEqual([
      { eventId: 'evt-a', deliveryKey: 'dk-1' },
      { eventId: 'evt-a', deliveryKey: 'dk-2' },
    ]);
    expect(store.getDelivery('evt-a', 'dk-1')).toMatchObject({
      state: 'failed',
      failureReason: 'ttl_expired',
    });
    expect(store.getDelivery('evt-a', 'dk-2')).toMatchObject({
      state: 'failed',
      failureReason: 'ttl_expired',
    });
    expect(store.getDelivery('evt-a', 'dk-3')!.state).toBe('delivered');
    expect(store.getById('evt-a')!.state).toBe('failed');
    expect(hookCalls).toEqual([
      { eventId: 'evt-a', deliveryKey: 'dk-1', reason: 'ttl_expired' },
      { eventId: 'evt-a', deliveryKey: 'dk-2', reason: 'ttl_expired' },
    ]);
  });

  test('leaves fresh rows untouched', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', TARGET);

    const expired = store.markPendingDeliveriesFailedBefore(Date.now() - 300_000, new Set());

    expect(expired).toEqual([]);
    expect(store.getDelivery('evt-a', 'dk-1')!.state).toBe('pending');
    expect(store.getById('evt-a')!.state).toBe('published');
  });

  test('skips in-flight delivery keys and keeps the event published while one is pending', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-in-flight', TARGET);
    store.registerExpectedDelivery('evt-a', 'dk-orphan', TARGET);

    const now = Date.now();
    ageEvent('evt-a', now - 400_000);

    const expired = store.markPendingDeliveriesFailedBefore(
      now - 300_000,
      new Set(['dk-in-flight']),
      now
    );

    expect(expired).toEqual([{ eventId: 'evt-a', deliveryKey: 'dk-orphan' }]);
    expect(store.getDelivery('evt-a', 'dk-in-flight')!.state).toBe('pending');
    expect(store.getDelivery('evt-a', 'dk-orphan')).toMatchObject({
      state: 'failed',
      failureReason: 'ttl_expired',
    });
    expect(store.getById('evt-a')!.state).toBe('published');
  });

  test('rolls up an event left published with all-terminal ttl_expired deliveries', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', TARGET);
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'ttl_expired' });
    expect(store.getById('evt-a')!.state).toBe('published');

    const expired = store.markPendingDeliveriesFailedBefore(Date.now() - 300_000, new Set());

    expect(expired).toEqual([]);
    expect(store.getById('evt-a')!.state).toBe('failed');
  });

  test('sweeps more distinct events than the SQLite host-parameter limit', () => {
    const now = Date.now();
    for (let i = 0; i < 1200; i += 1) {
      const event: ExternalEvent = {
        ...EVENT_A,
        id: `evt-bulk-${i}`,
        dedupeKey: `dedupe-bulk-${i}`,
      };
      store.store(event);
      store.registerExpectedDelivery(event.id, `dk-bulk-${i}`, TARGET);
      ageEvent(event.id, now - 400_000);
    }

    const expired = store.markPendingDeliveriesFailedBefore(now - 300_000, new Set(), now);

    expect(expired).toHaveLength(1200);
    expect(store.getById('evt-bulk-0')!.state).toBe('failed');
    expect(store.getById('evt-bulk-1199')!.state).toBe('failed');
    expect(store.summarizePendingDeliveries(now + 1)?.count ?? 0).toBe(0);
  });
});

describe('markEventDeliveredIfAllDeliveriesDelivered', () => {
  test('delivers when all deliveries are delivered', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-2', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-2',
      agentName: 'reviewer',
    });

    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    store.markEventDeliveredIfAllDeliveriesDelivered('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');

    store.markDeliveryMailboxAccepted('evt-a', 'dk-2');
    store.markEventDeliveredIfAllDeliveriesDelivered('evt-a');
    expect(store.getById('evt-a')!.state).toBe('delivered');
  });

  test('no-op when some deliveries are pending', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-2', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-2',
      agentName: 'reviewer',
    });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    store.markEventDeliveredIfAllDeliveriesDelivered('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');
  });

  test('no-op when no deliveries registered', () => {
    store.store(EVENT_A);
    store.markEventDeliveredIfAllDeliveriesDelivered('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');
  });

  test('no-op when event is already terminal', () => {
    store.store(EVENT_A);
    store.markEventIgnored('evt-a', 'no_matching_subscriptions');
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    store.markEventDeliveredIfAllDeliveriesDelivered('evt-a');
    expect(store.getById('evt-a')!.state).toBe('ignored');
  });
});

describe('markEventFailedIfAnyDeliveryTerminalFailed', () => {
  test('fails when any delivery is terminal failed', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-2', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-2',
      agentName: 'reviewer',
    });

    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'node cancelled' });
    store.markEventFailedIfAnyDeliveryTerminalFailed('evt-a');
    expect(store.getById('evt-a')!.state).toBe('failed');
  });

  test('no-op when no deliveries are failed', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    store.markEventFailedIfAnyDeliveryTerminalFailed('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');
  });

  test('no-op when event is already terminal', () => {
    store.store(EVENT_A);
    store.markEventIgnored('evt-a', 'no_matching_subscriptions');
    store.markEventFailedIfAnyDeliveryTerminalFailed('evt-a');
    expect(store.getById('evt-a')!.state).toBe('ignored');
  });
});

describe('markEventFailedIfAllDeliveriesTerminal', () => {
  test('fails when all are terminal and at least one is failed', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-2', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-2',
      agentName: 'reviewer',
    });

    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'boom' });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-2');
    store.markEventFailedIfAllDeliveriesTerminal('evt-a');
    expect(store.getById('evt-a')!.state).toBe('failed');
  });

  test('no-op when all are terminal but none are failed', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-2', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-2',
      agentName: 'reviewer',
    });
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    store.markDeliveryMailboxAccepted('evt-a', 'dk-2');
    store.markEventFailedIfAllDeliveriesTerminal('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');
  });

  test('no-op when some deliveries are still pending', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-a', 'dk-2', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-2',
      agentName: 'reviewer',
    });
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'boom' });
    store.markEventFailedIfAllDeliveriesTerminal('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');
  });

  test('no-op when no deliveries registered', () => {
    store.store(EVENT_A);
    store.markEventFailedIfAllDeliveriesTerminal('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');
  });
});

describe('markEventFailed', () => {
  test('advances published → failed', () => {
    store.store(EVENT_A);
    store.markEventFailed('evt-a', { terminal: true, reason: 'enrichment error' });
    expect(store.getById('evt-a')!.state).toBe('failed');
  });

  test('no-op when already terminal', () => {
    store.store(EVENT_A);
    store.markEventIgnored('evt-a', 'no_matching_subscriptions');
    store.markEventFailed('evt-a', { terminal: true, reason: 'enrichment error' });
    expect(store.getById('evt-a')!.state).toBe('ignored');
  });

  test('rejects non-terminal failure', () => {
    store.store(EVENT_A);
    expect(() => store.markEventFailed('evt-a', { terminal: false, reason: 'transient' })).toThrow(
      'requires failure.terminal=true'
    );
  });
});

describe('markEventIgnored', () => {
  test('advances published → ignored', () => {
    store.store(EVENT_A);
    store.markEventIgnored('evt-a', 'no_matching_subscriptions');
    expect(store.getById('evt-a')!.state).toBe('ignored');
  });

  test('no-op when already terminal', () => {
    store.store(EVENT_A);
    store.markEventFailed('evt-a', { terminal: true, reason: 'boom' });
    store.markEventIgnored('evt-a', 'no_matching_subscriptions');
    expect(store.getById('evt-a')!.state).toBe('failed');
  });
});

describe('cross-event isolation', () => {
  test('events with different dedupe keys are independent', () => {
    store.store(EVENT_A);
    store.store(EVENT_B);
    expect(store.getById('evt-a')!.state).toBe('published');
    expect(store.getById('evt-b')!.state).toBe('published');
  });

  test('deliveries are scoped to event id', () => {
    store.store(EVENT_A);
    store.store(EVENT_B);
    store.registerExpectedDelivery('evt-a', 'dk-a', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-b', 'dk-b', {
      workflowRunId: 'run-1',
      taskId: 'task-2',
      nodeId: 'node-1',
      agentName: 'coder',
    });

    store.markDeliveryMailboxAccepted('evt-a', 'dk-a');
    expect(store.getDelivery('evt-a', 'dk-a')!.state).toBe('delivered');
    expect(store.getDelivery('evt-b', 'dk-b')!.state).toBe('pending');
  });
});

describe('delivery-terminal hook', () => {
  function registerPending(deliveryKey = 'dk-1'): void {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', deliveryKey, {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
  }

  test('fires delivered on a real terminal transition', () => {
    const events: Array<{ outcome: string; reason: string | null }> = [];
    store.setDeliveryTerminalHook((event) =>
      events.push({ outcome: event.outcome, reason: event.reason })
    );
    registerPending();
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');

    expect(events).toEqual([{ outcome: 'delivered', reason: null }]);
  });

  test('fires failed only for terminal failures, with reason', () => {
    const events: Array<{ outcome: string; reason: string | null }> = [];
    store.setDeliveryTerminalHook((event) =>
      events.push({ outcome: event.outcome, reason: event.reason })
    );
    registerPending();

    store.markDeliveryFailed('evt-a', 'dk-1', {
      terminal: false,
      reason: 'node_execution_not_active',
    });
    expect(events).toHaveLength(0);

    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'ttl_expired' });
    expect(events).toEqual([{ outcome: 'failed', reason: 'ttl_expired' }]);
  });

  test('does not fire when the row is already terminal (no double-count)', () => {
    const events: string[] = [];
    store.setDeliveryTerminalHook((event) => events.push(event.outcome));
    registerPending();

    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    store.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    store.markDeliveryFailed('evt-a', 'dk-1', { terminal: true, reason: 'late' });

    expect(events).toEqual(['delivered']);
  });
});

describe('summarizePendingDeliveries', () => {
  test('returns null when there are no pending deliveries', () => {
    expect(store.summarizePendingDeliveries(Date.now())).toBeNull();
  });

  test('returns count + min/max/avg/p95 age without materializing rows', () => {
    const now = Date.now();
    store.store(EVENT_A);
    store.store(EVENT_B);
    store.registerExpectedDelivery('evt-a', 'dk-a', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-b', 'dk-b', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      now - 60_000,
      'evt-a'
    );
    db.prepare(`UPDATE space_external_events SET created_at = ? WHERE id = ?`).run(
      now - 30_000,
      'evt-b'
    );

    const summary = store.summarizePendingDeliveries(now);
    expect(summary).not.toBeNull();
    expect(summary!.count).toBe(2);
    expect(summary!.minMs).toBeGreaterThanOrEqual(29_000);
    expect(summary!.minMs).toBeLessThanOrEqual(31_000);
    expect(summary!.maxMs).toBeGreaterThanOrEqual(59_000);
    expect(summary!.maxMs).toBeLessThanOrEqual(61_000);
    expect(summary!.avgMs).toBeGreaterThanOrEqual(44_000);
    expect(summary!.avgMs).toBeLessThanOrEqual(46_000);
    expect(summary!.p95Ms).toBe(summary!.maxMs);

    store.markDeliveryMailboxAccepted('evt-b', 'dk-b');
    const afterDeliver = store.summarizePendingDeliveries(now);
    expect(afterDeliver!.count).toBe(1);
    expect(afterDeliver!.minMs).toBe(afterDeliver!.maxMs);
    expect(afterDeliver!.p95Ms).toBe(afterDeliver!.maxMs);
  });

  test('counts distinct pending delivery targets', () => {
    const now = Date.now();
    store.store(EVENT_A);
    store.store(EVENT_B);
    store.registerExpectedDelivery('evt-a', 'dk-a', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.registerExpectedDelivery('evt-b', 'dk-b', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });

    const sameTarget = store.summarizePendingDeliveries(now);
    expect(sameTarget!.count).toBe(2);
    expect(sameTarget!.distinctTargets).toBe(1);

    store.registerExpectedDelivery('evt-a', 'dk-a-run2', {
      workflowRunId: 'run-2',
      taskId: 'task-2',
      nodeId: 'node-2',
      agentName: 'coder',
    });
    const twoTargets = store.summarizePendingDeliveries(now);
    expect(twoTargets!.count).toBe(3);
    expect(twoTargets!.distinctTargets).toBe(2);
  });

  test('counts targets whose fields contain the delimiter as distinct', () => {
    const now = Date.now();
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-pipe-a', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'x',
      agentName: 'y|z',
    });
    store.registerExpectedDelivery('evt-a', 'dk-pipe-b', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'x|y',
      agentName: 'z',
    });

    const summary = store.summarizePendingDeliveries(now);
    expect(summary!.count).toBe(2);
    expect(summary!.distinctTargets).toBe(2);
  });
});

describe('reactive invalidation', () => {
  function makeReactiveSpy() {
    const calls: string[] = [];
    const reactiveDb = { notifyChange: (table: string) => void calls.push(table) };
    return { reactiveDb, calls };
  }

  function deliveryTarget() {
    return {
      workflowRunId: 'wr-1',
      taskId: 'task-1',
      nodeId: 'coder',
      agentName: 'coder',
    };
  }

  test('store() notifies space_external_events on a fresh insert', () => {
    const { reactiveDb, calls } = makeReactiveSpy();
    const s = new ExternalEventStore(db, reactiveDb);
    s.store(EVENT_A);
    expect(calls).toContain('space_external_events');
  });

  test('store() does not notify on a duplicate (no row changed)', () => {
    const { reactiveDb, calls } = makeReactiveSpy();
    const s = new ExternalEventStore(db, reactiveDb);
    s.store(EVENT_A);
    calls.length = 0;
    s.store(EVENT_A);
    expect(calls).toEqual([]);
  });

  test('registerExpectedDelivery() notifies the deliveries table', () => {
    const { reactiveDb, calls } = makeReactiveSpy();
    const s = new ExternalEventStore(db, reactiveDb);
    s.store(EVENT_A);
    calls.length = 0;
    s.registerExpectedDelivery('evt-a', 'dk-1', deliveryTarget());
    expect(calls).toContain('space_external_event_deliveries');
  });

  test('markDeliveryMailboxAccepted() notifies both tables', () => {
    const { reactiveDb, calls } = makeReactiveSpy();
    const s = new ExternalEventStore(db, reactiveDb);
    s.store(EVENT_A);
    s.registerExpectedDelivery('evt-a', 'dk-1', deliveryTarget());
    calls.length = 0;
    s.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    expect(calls).toContain('space_external_event_deliveries');
    expect(calls).toContain('space_external_events');
  });

  test('markDeliveriesDeliveredAtomic() notifies each table once regardless of mark count', () => {
    const { reactiveDb, calls } = makeReactiveSpy();
    const s = new ExternalEventStore(db, reactiveDb);
    s.store(EVENT_A);
    s.registerExpectedDelivery('evt-a', 'dk-1', deliveryTarget());
    s.registerExpectedDelivery('evt-a', 'dk-2', deliveryTarget());
    calls.length = 0;
    s.markDeliveriesDeliveredAtomic([
      { eventId: 'evt-a', deliveryKey: 'dk-1' },
      { eventId: 'evt-a', deliveryKey: 'dk-2' },
    ]);
    expect(calls.filter((table) => table === 'space_external_event_deliveries')).toHaveLength(1);
    expect(calls.filter((table) => table === 'space_external_events')).toHaveLength(1);
  });

  test('no reactiveDb → writes still succeed without throwing', () => {
    const s = new ExternalEventStore(db);
    expect(() => {
      s.store(EVENT_A);
      s.registerExpectedDelivery('evt-a', 'dk-1', deliveryTarget());
      s.markDeliveryMailboxAccepted('evt-a', 'dk-1');
    }).not.toThrow();
  });
});

describe('listEventCountsByTopic', () => {
  test('groups events by topic and reports count + most recent ingested_at', () => {
    store.store(EVENT_A);
    store.store({
      ...EVENT_A,
      id: 'evt-a2',
      dedupeKey: 'github:pr:42:review_submitted:12346',
      occurredAt: 1_700_000_500_000,
      ingestedAt: 1_700_000_501_000,
    });
    store.store(EVENT_B);

    const counts = store.listEventCountsByTopic({ spaceId: SPACE_ID, source: 'github' });
    const byTopic = new Map(counts.map((c) => [c.topic, c]));
    expect(byTopic.get(EVENT_A.topic)).toEqual({
      topic: EVENT_A.topic,
      count: 2,
      lastAt: 1_700_000_501_000,
    });
    expect(byTopic.get(EVENT_B.topic)).toEqual({
      topic: EVENT_B.topic,
      count: 1,
      lastAt: 1_700_000_101_000,
    });
  });

  test('counts a late-ingested event by ingested_at, not its older occurred_at', () => {
    const recent = Date.now();
    store.store({
      ...EVENT_A,
      occurredAt: recent - 48 * 60 * 60 * 1000,
      ingestedAt: recent,
    });
    const counts = store.listEventCountsByTopic({
      spaceId: SPACE_ID,
      source: 'github',
      since: recent - 60_000,
    });
    expect(counts).toHaveLength(1);
    expect(counts[0].count).toBe(1);
    expect(counts[0].lastAt).toBe(recent);
  });

  test('filters by source and applies the since cutoff', () => {
    store.store(EVENT_A);
    store.store({
      ...EVENT_A,
      id: 'evt-space',
      source: 'space',
      topic: 'space/foo/bar/1',
      dedupeKey: 'space:1',
    });
    const githubOnly = store.listEventCountsByTopic({ spaceId: SPACE_ID, source: 'github' });
    expect(githubOnly).toHaveLength(1);
    expect(githubOnly[0].topic).toBe(EVENT_A.topic);
    expect(
      store.listEventCountsByTopic({
        spaceId: SPACE_ID,
        source: 'github',
        since: 1_700_000_002_000,
      })
    ).toEqual([]);
  });

  test('requires a spaceId', () => {
    expect(() => store.listEventCountsByTopic({ spaceId: '' })).toThrow(
      ExternalEventValidationError
    );
  });
});
