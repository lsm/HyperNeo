import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  PendingAgentMessageRepository,
  DEFAULT_PENDING_MESSAGE_MAX_ATTEMPTS,
  DEFAULT_PENDING_MESSAGE_MAX_PER_TARGET,
  DEFAULT_PENDING_MESSAGE_RETENTION_MS,
} from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

let db: Database;
let repo: PendingAgentMessageRepository;

const SPACE_ID = 'sp1';
const RUN_ID = 'run-001';
const TASK_ID = 'task-001';

function freshDb(): Database {
  const d = new Database(':memory:');
  createSpaceTables(d);
  const now = Date.now();
  d.exec(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('${SPACE_ID}', '${SPACE_ID}', '/tmp/test-pending', 'Test Space', ${now}, ${now})`
  );
  d.exec(
    `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf1', '${SPACE_ID}', 'Test Workflow', ${now}, ${now})`
  );
  d.exec(
    `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, started_at, completed_at, created_at, updated_at) VALUES ('${RUN_ID}', '${SPACE_ID}', 'wf1', 'Test Run', 'in_progress', NULL, NULL, ${now}, ${now})`
  );
  return d;
}

beforeEach(() => {
  db = freshDb();
  repo = new PendingAgentMessageRepository(db);
});

describe('PendingAgentMessageRepository — enqueue', () => {
  test('inserts a new row with defaults', () => {
    const { record, deduped } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      taskId: TASK_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'review this',
    });

    expect(deduped).toBe(false);
    expect(record.workflowRunId).toBe(RUN_ID);
    expect(record.spaceId).toBe(SPACE_ID);
    expect(record.taskId).toBe(TASK_ID);
    expect(record.sourceAgentName).toBe('task-agent');
    expect(record.targetKind).toBe('node_agent');
    expect(record.targetAgentName).toBe('coder');
    expect(record.message).toBe('review this');
    expect(record.idempotencyKey).toBeNull();
    expect(record.attempts).toBe(0);
    expect(record.maxAttempts).toBe(DEFAULT_PENDING_MESSAGE_MAX_ATTEMPTS);
    expect(record.status).toBe('pending');
    expect(record.deliveredAt).toBeNull();
    expect(record.deliveredSessionId).toBeNull();
    expect(record.lastAttemptAt).toBeNull();
    expect(record.lastError).toBeNull();
    expect(record.expiresAt).toBeGreaterThan(Date.now());
    expect(typeof record.createdAt).toBe('number');
    expect(record.deliveryMode).toBeNull();
  });

  test('persists deliveryMode and reads it back (defer survives the queue)', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'for next turn',
      deliveryMode: 'defer',
    });
    expect(record.deliveryMode).toBe('defer');
    expect(repo.getById(record.id)?.deliveryMode).toBe('defer');
    expect(repo.listPendingForTarget(RUN_ID, 'coder')[0].deliveryMode).toBe('defer');
  });

  test('honours ttlMs by setting expiresAt = now + ttl', () => {
    const before = Date.now();
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'hello',
      ttlMs: 500,
    });
    expect(record.expiresAt).toBeGreaterThanOrEqual(before + 500);
    expect(record.expiresAt).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('honours custom maxAttempts', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'hello',
      maxAttempts: 2,
    });
    expect(record.maxAttempts).toBe(2);
  });

  test('honours custom sourceAgentName', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'space_agent',
      targetAgentName: 'space-agent',
      sourceAgentName: 'task-agent',
      message: 'escalate',
    });
    expect(record.sourceAgentName).toBe('task-agent');
    expect(record.targetKind).toBe('space_agent');
  });

  test('idempotencyKey de-duplicates repeat enqueues', () => {
    const first = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'msg-1',
      idempotencyKey: 'key-abc',
    });
    const second = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'msg-1-repeat',
      idempotencyKey: 'key-abc',
    });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.message).toBe('msg-1');
  });

  test('idempotencyKey is scoped by (runId, targetAgentName)', () => {
    const a = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'for-coder',
      idempotencyKey: 'shared',
    });
    const b = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'reviewer',
      message: 'for-reviewer',
      idempotencyKey: 'shared',
    });
    expect(a.record.id).not.toBe(b.record.id);
    expect(b.deduped).toBe(false);
  });

  test('listPendingForTarget scopes by workflowNodeId so same-named nodes do not cross-drain', () => {
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'reviewer',
      message: 'for-node-1',
      workflowNodeId: 'node-1',
    });
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'reviewer',
      message: 'for-node-2',
      workflowNodeId: 'node-2',
    });
    expect(repo.listPendingForTarget(RUN_ID, 'reviewer')).toHaveLength(2);
    const forNode2 = repo.listPendingForTarget(RUN_ID, 'reviewer', 'node-2');
    expect(forNode2).toHaveLength(1);
    expect(forNode2[0].message).toBe('for-node-2');
    expect(forNode2[0].workflowNodeId).toBe('node-2');
    expect(repo.listPendingForTarget(RUN_ID, 'reviewer', 'node-1')[0].message).toBe('for-node-1');
  });

  test('legacy rows without workflowNodeId drain for every node (backward compatible)', () => {
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'legacy',
    });
    const forAnyNode = repo.listPendingForTarget(RUN_ID, 'coder', 'node-9');
    expect(forAnyNode).toHaveLength(1);
    expect(forAnyNode[0].workflowNodeId).toBeNull();
  });

  test('two enqueues without idempotencyKey produce distinct rows', () => {
    const a = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'a',
    });
    const b = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'b',
    });
    expect(a.record.id).not.toBe(b.record.id);
    expect(b.deduped).toBe(false);
  });
});

describe('PendingAgentMessageRepository — listPending', () => {
  test('listPendingForTarget returns rows in FIFO order', () => {
    const a = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'first',
    });
    const b = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'second',
    });

    const rows = repo.listPendingForTarget(RUN_ID, 'coder');
    expect(rows.map((r) => r.id)).toEqual([a.record.id, b.record.id]);
    expect(rows.map((r) => r.message)).toEqual(['first', 'second']);
  });

  test('listPendingForTarget filters by target', () => {
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'for-coder',
    });
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'reviewer',
      message: 'for-reviewer',
    });

    const forCoder = repo.listPendingForTarget(RUN_ID, 'coder');
    const forReviewer = repo.listPendingForTarget(RUN_ID, 'reviewer');
    expect(forCoder).toHaveLength(1);
    expect(forReviewer).toHaveLength(1);
    expect(forCoder[0].message).toBe('for-coder');
    expect(forReviewer[0].message).toBe('for-reviewer');
  });

  test('listPendingForTarget excludes delivered rows', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'hello',
    });
    repo.markDelivered(record.id, 'sess-1');

    const rows = repo.listPendingForTarget(RUN_ID, 'coder');
    expect(rows).toHaveLength(0);
  });

  test('listPendingForRun returns every pending row for the run', () => {
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'a',
    });
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'space_agent',
      targetAgentName: 'space-agent',
      message: 'b',
    });
    const rows = repo.listPendingForRun(RUN_ID);
    expect(rows).toHaveLength(2);
  });
});

describe('PendingAgentMessageRepository — markDelivered', () => {
  test('transitions a pending row to delivered with session id', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'hi',
    });

    repo.markDelivered(record.id, 'sess-xyz');

    const after = repo.getById(record.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('delivered');
    expect(after!.deliveredSessionId).toBe('sess-xyz');
    expect(after!.deliveredAt).not.toBeNull();
    expect(after!.lastAttemptAt).not.toBeNull();
    expect(after!.lastError).toBeNull();
  });

  test('is a no-op when the row is no longer pending', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'hi',
    });
    repo.markDelivered(record.id, 'sess-1');
    repo.markDelivered(record.id, 'sess-2');

    const after = repo.getById(record.id);
    expect(after!.deliveredSessionId).toBe('sess-1');
  });
});

describe('PendingAgentMessageRepository — markAttemptFailed', () => {
  test('increments attempts and records last_error', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'hi',
      maxAttempts: 3,
    });

    const after = repo.markAttemptFailed(record.id, 'boom');
    expect(after!.attempts).toBe(1);
    expect(after!.lastError).toBe('boom');
    expect(after!.lastAttemptAt).not.toBeNull();
    expect(after!.status).toBe('pending');
  });

  test('transitions to failed once attempts reach maxAttempts', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'hi',
      maxAttempts: 2,
    });

    repo.markAttemptFailed(record.id, 'err-1');
    const after = repo.markAttemptFailed(record.id, 'err-2');

    expect(after!.attempts).toBe(2);
    expect(after!.status).toBe('failed');
    repo.markAttemptFailed(record.id, 'err-3');
    const again = repo.getById(record.id);
    expect(again!.attempts).toBe(2);
    expect(again!.lastError).toBe('err-2');
  });
});

describe('PendingAgentMessageRepository — enforceRetention', () => {
  test('expires pending rows older than the retention window', () => {
    const now = Date.now();
    const old = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'old',
    });
    const fresh = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'fresh',
    });
    db.prepare('UPDATE pending_agent_messages SET created_at = ? WHERE id = ?').run(
      now - DEFAULT_PENDING_MESSAGE_RETENTION_MS - 1,
      old.record.id
    );
    db.prepare('UPDATE pending_agent_messages SET created_at = ? WHERE id = ?').run(
      now,
      fresh.record.id
    );

    const count = repo.enforceRetention({ runId: RUN_ID, now });

    expect(count).toBe(1);
    expect(repo.getById(old.record.id)!.status).toBe('expired');
    expect(repo.getById(fresh.record.id)!.status).toBe('pending');
  });

  test('expires rows whose per-message TTL elapsed before applying the cap', () => {
    const now = Date.now();
    const stillValid = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'valid',
      expiresAt: now + 60_000,
    });
    const expired = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'expired',
      expiresAt: now - 1,
    });
    db.prepare('UPDATE pending_agent_messages SET created_at = ? WHERE id = ?').run(
      now,
      stillValid.record.id
    );
    db.prepare('UPDATE pending_agent_messages SET created_at = ? WHERE id = ?').run(
      now + 1,
      expired.record.id
    );

    const count = repo.enforceRetention({ runId: RUN_ID, now, maxPerTarget: 1 });

    expect(count).toBe(1);
    expect(repo.getById(expired.record.id)!.status).toBe('expired');
    expect(repo.getById(stillValid.record.id)!.status).toBe('pending');
  });

  test('keeps only the newest maxPerTarget pending rows for a target', () => {
    const now = Date.now();
    const records = Array.from(
      { length: DEFAULT_PENDING_MESSAGE_MAX_PER_TARGET + 2 },
      (_, index) => {
        const { record } = repo.enqueue({
          workflowRunId: RUN_ID,
          spaceId: SPACE_ID,
          targetKind: 'node_agent',
          targetAgentName: 'coder',
          message: `msg-${index}`,
        });
        db.prepare('UPDATE pending_agent_messages SET created_at = ? WHERE id = ?').run(
          now + index,
          record.id
        );
        return record;
      }
    );

    const count = repo.enforceRetention({ runId: RUN_ID, now: now + records.length });

    expect(count).toBe(2);
    const pending = repo.listPendingForTarget(RUN_ID, 'coder');
    expect(pending).toHaveLength(DEFAULT_PENDING_MESSAGE_MAX_PER_TARGET);
    expect(repo.getById(records[0].id)!.status).toBe('expired');
    expect(repo.getById(records[1].id)!.status).toBe('expired');
    expect(repo.getById(records[2].id)!.status).toBe('pending');
  });

  test('applies maxPerTarget separately per run and target', () => {
    const now = Date.now();
    db.exec(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, started_at, completed_at, created_at, updated_at) VALUES ('run-002', '${SPACE_ID}', 'wf1', 'Run 2', 'in_progress', NULL, NULL, ${now}, ${now})`
    );

    for (let index = 0; index < 3; index++) {
      for (const [runId, targetAgentName] of [
        [RUN_ID, 'coder'],
        [RUN_ID, 'reviewer'],
        ['run-002', 'coder'],
      ] as const) {
        const { record } = repo.enqueue({
          workflowRunId: runId,
          spaceId: SPACE_ID,
          targetKind: 'node_agent',
          targetAgentName,
          message: `${runId}-${targetAgentName}-${index}`,
        });
        db.prepare('UPDATE pending_agent_messages SET created_at = ? WHERE id = ?').run(
          now + index,
          record.id
        );
      }
    }

    const count = repo.enforceRetention({ now: now + 3, maxPerTarget: 2 });

    expect(count).toBe(3);
    expect(repo.listPendingForTarget(RUN_ID, 'coder')).toHaveLength(2);
    expect(repo.listPendingForTarget(RUN_ID, 'reviewer')).toHaveLength(2);
    expect(repo.listPendingForTarget('run-002', 'coder')).toHaveLength(2);
  });

  test('partitions the maxPerTarget cap by workflow node (same-slot nodes are independent)', () => {
    const now = Date.now();
    for (const [nodeId, idx] of [
      ['node-a', 0],
      ['node-a', 1],
      ['node-b', 0],
      ['node-b', 1],
    ] as const) {
      const { record } = repo.enqueue({
        workflowRunId: RUN_ID,
        spaceId: SPACE_ID,
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        message: `${nodeId}-${idx}`,
        workflowNodeId: nodeId,
      });
      db.prepare('UPDATE pending_agent_messages SET created_at = ? WHERE id = ?').run(
        now + idx,
        record.id
      );
    }

    const count = repo.enforceRetention({ now: now + 3, maxPerTarget: 2 });
    expect(count).toBe(0);
    expect(repo.listPendingForTarget(RUN_ID, 'reviewer', 'node-a')).toHaveLength(2);
    expect(repo.listPendingForTarget(RUN_ID, 'reviewer', 'node-b')).toHaveLength(2);
  });
});

describe('PendingAgentMessageRepository — expireStale', () => {
  test('moves expired pending rows to expired', () => {
    const { record: stale } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'stale',
      expiresAt: Date.now() - 1_000,
    });
    const { record: fresh } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'fresh',
      expiresAt: Date.now() + 60_000,
    });

    const count = repo.expireStale(RUN_ID);
    expect(count).toBe(1);

    const staleAfter = repo.getById(stale.id);
    expect(staleAfter!.status).toBe('expired');
    const freshAfter = repo.getById(fresh.id);
    expect(freshAfter!.status).toBe('pending');
  });

  test('runId=null sweeps across all runs', () => {
    const now = Date.now();
    db.exec(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, started_at, completed_at, created_at, updated_at) VALUES ('run-002', '${SPACE_ID}', 'wf1', 'Run 2', 'in_progress', NULL, NULL, ${now}, ${now})`
    );

    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'a',
      expiresAt: now - 1,
    });
    repo.enqueue({
      workflowRunId: 'run-002',
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'b',
      expiresAt: now - 1,
    });

    const count = repo.expireStale();
    expect(count).toBe(2);
  });
});

describe('PendingAgentMessageRepository — delete + cascade', () => {
  test('deleteByRun removes every row for a run', () => {
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'a',
    });
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'reviewer',
      message: 'b',
    });
    const count = repo.deleteByRun(RUN_ID);
    expect(count).toBe(2);
    expect(repo.listAllForRun(RUN_ID)).toEqual([]);
  });

  test('deleting the parent workflow run cascades', () => {
    repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'a',
    });
    expect(repo.listAllForRun(RUN_ID)).toHaveLength(1);

    db.prepare('DELETE FROM space_workflow_runs WHERE id = ?').run(RUN_ID);
    expect(repo.listAllForRun(RUN_ID)).toHaveLength(0);
  });
});

describe('PendingAgentMessageRepository — findByIdempotencyKey', () => {
  test('returns null for unknown keys', () => {
    expect(repo.findByIdempotencyKey(RUN_ID, 'coder', 'nope')).toBeNull();
  });

  test('returns null for empty key', () => {
    expect(repo.findByIdempotencyKey(RUN_ID, 'coder', '')).toBeNull();
  });

  test('returns the matching row when present', () => {
    const { record } = repo.enqueue({
      workflowRunId: RUN_ID,
      spaceId: SPACE_ID,
      targetKind: 'node_agent',
      targetAgentName: 'coder',
      message: 'hi',
      idempotencyKey: 'k-1',
    });
    const found = repo.findByIdempotencyKey(RUN_ID, 'coder', 'k-1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(record.id);
  });
});
