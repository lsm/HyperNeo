/**
 * ExternalEventStore Unit Tests
 *
 * Covers:
 *   - store: first observation, terminal duplicate short-circuit, retryable duplicate re-emit
 *   - registerExpectedDelivery: idempotency, preservation of terminal state
 *   - markDeliveryDelivered / markDeliveryFailed: terminal vs transient failure
 *   - markEventDeliveredIfAllDeliveriesDelivered: only when all deliveries delivered
 *   - markEventFailedIfAnyDeliveryTerminalFailed: any terminal failure → source failed
 *   - markEventFailedIfAllDeliveriesTerminal: only when all terminal AND at least one failed
 *   - markEventFailed / markEventIgnored: terminalization
 *   - getEventIdForDeliveryKey / isDeliveryTerminal
 *   - Validation: missing fields, source mismatch, topic mismatch, unknown source
 *
 * Uses an in-memory SQLite DB seeded with the full Space schema so FK constraints
 * match production.
 */

import { Database } from 'bun:sqlite';
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

// ---------------------------------------------------------------------------
// store — first observation
// ---------------------------------------------------------------------------

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
    // Source-specific metadata lives in payload
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

// ---------------------------------------------------------------------------
// store — duplicate handling
// ---------------------------------------------------------------------------

describe('store — duplicate handling', () => {
  test('terminal duplicate short-circuits (delivered)', () => {
    store.store(EVENT_A);
    store.markEventIgnored('evt-a', 'no_matching_subscriptions');

    const dup = store.store({ ...EVENT_A, id: 'evt-a-dup' });
    expect(dup.duplicate).toBe(true);
    expect(dup.terminal).toBe(true);
    expect(dup.event.id).toBe('evt-a'); // canonical id
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// registerExpectedDelivery
// ---------------------------------------------------------------------------

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

  test('preserves terminal state on duplicate registration', () => {
    store.store(EVENT_A);
    const target = {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    };
    store.registerExpectedDelivery('evt-a', 'dk-1', target);
    store.markDeliveryDelivered('evt-a', 'dk-1');
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

// ---------------------------------------------------------------------------
// isDeliveryTerminal / getEventIdForDeliveryKey
// ---------------------------------------------------------------------------

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
    store.markDeliveryDelivered('evt-a', 'dk-1');
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

// ---------------------------------------------------------------------------
// markDeliveryDelivered
// ---------------------------------------------------------------------------

describe('markDeliveryDelivered', () => {
  test('advances pending → delivered', () => {
    store.store(EVENT_A);
    store.registerExpectedDelivery('evt-a', 'dk-1', {
      workflowRunId: 'run-1',
      taskId: 'task-1',
      nodeId: 'node-1',
      agentName: 'coder',
    });
    store.markDeliveryDelivered('evt-a', 'dk-1');
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
    store.markDeliveryDelivered('evt-a', 'dk-1');
    const before = store.getDelivery('evt-a', 'dk-1')!;
    store.markDeliveryDelivered('evt-a', 'dk-1');
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
    store.markDeliveryDelivered('evt-a', 'dk-1');
    const d = store.getDelivery('evt-a', 'dk-1');
    expect(d!.state).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// markDeliveryFailed
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// markEventDeliveredIfAllDeliveriesDelivered
// ---------------------------------------------------------------------------

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

    store.markDeliveryDelivered('evt-a', 'dk-1');
    store.markEventDeliveredIfAllDeliveriesDelivered('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published'); // not yet

    store.markDeliveryDelivered('evt-a', 'dk-2');
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
    store.markDeliveryDelivered('evt-a', 'dk-1');
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
    store.markDeliveryDelivered('evt-a', 'dk-1');
    store.markEventDeliveredIfAllDeliveriesDelivered('evt-a');
    expect(store.getById('evt-a')!.state).toBe('ignored');
  });
});

// ---------------------------------------------------------------------------
// markEventFailedIfAnyDeliveryTerminalFailed
// ---------------------------------------------------------------------------

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
    store.markDeliveryDelivered('evt-a', 'dk-1');
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

// ---------------------------------------------------------------------------
// markEventFailedIfAllDeliveriesTerminal
// ---------------------------------------------------------------------------

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
    store.markDeliveryDelivered('evt-a', 'dk-2');
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
    store.markDeliveryDelivered('evt-a', 'dk-1');
    store.markDeliveryDelivered('evt-a', 'dk-2');
    store.markEventFailedIfAllDeliveriesTerminal('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published'); // not yet delivered
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
    // dk-2 still pending
    store.markEventFailedIfAllDeliveriesTerminal('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');
  });

  test('no-op when no deliveries registered', () => {
    store.store(EVENT_A);
    store.markEventFailedIfAllDeliveriesTerminal('evt-a');
    expect(store.getById('evt-a')!.state).toBe('published');
  });
});

// ---------------------------------------------------------------------------
// markEventFailed / markEventIgnored
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cross-event isolation
// ---------------------------------------------------------------------------

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

    store.markDeliveryDelivered('evt-a', 'dk-a');
    expect(store.getDelivery('evt-a', 'dk-a')!.state).toBe('delivered');
    expect(store.getDelivery('evt-b', 'dk-b')!.state).toBe('pending');
  });
});
