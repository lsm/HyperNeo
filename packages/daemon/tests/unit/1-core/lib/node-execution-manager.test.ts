/**
 * Unit tests for NodeExecutionManager
 *
 * Covers:
 *   Pure-function layer:
 *   1.  VALID_NODE_EXECUTION_TRANSITIONS — has all 6 statuses as keys
 *   2.  isValidNodeExecutionTransition: pending → in_progress — valid
 *   3.  isValidNodeExecutionTransition: pending → cancelled — valid
 *   4.  isValidNodeExecutionTransition: in_progress → done — valid
 *   5.  isValidNodeExecutionTransition: in_progress → blocked — valid
 *   6.  isValidNodeExecutionTransition: in_progress → cancelled — valid
 *   7.  isValidNodeExecutionTransition: done → in_progress — valid (reactivation)
 *   8.  isValidNodeExecutionTransition: blocked → in_progress — valid (retry)
 *   9.  isValidNodeExecutionTransition: blocked → cancelled — valid
 *   10. isValidNodeExecutionTransition: cancelled → in_progress — valid (retry)
 *   11. isValidNodeExecutionTransition: pending → done — invalid
 *   12. isValidNodeExecutionTransition: pending → blocked — invalid
 *   13. isNodeExecutionTerminal: done → true
 *   14. isNodeExecutionTerminal: cancelled → true
 *   15. isNodeExecutionTerminal: pending → false
 *   16. isNodeExecutionTerminal: in_progress → false
 *   17. isNodeExecutionTerminal: blocked → false
 *   18. TERMINAL_NODE_EXECUTION_STATUSES size=2
 *
 *   Manager (with real DB):
 *   19. setExecutionStatus: pending → in_progress persists and stamps startedAt
 *   20. setExecutionStatus: in_progress → done stamps completedAt
 *   21. setExecutionStatus: in_progress → blocked stamps completedAt
 *   22. setExecutionStatus: in_progress → cancelled stamps completedAt
 *   23. setExecutionStatus: done → in_progress (reactivation) clears completedAt
 *   24. setExecutionStatus: blocked → in_progress (retry)
 *   25. setExecutionStatus: throws on not-found execution
 *   26. setExecutionStatus: throws on invalid transition (pending → done)
 *   27. listByWorkflowRun: returns executions for correct run only
 *   28. listByNode: returns executions for specific node within run
 *   29. setAgentSessionId: updates session ID
 *   30. setAgentSessionId: clears session ID with null
 *   31. delete: removes execution by ID
 *   32. deleteByWorkflowRun: removes all executions for a run
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { NodeExecutionManager } from '../../../../src/lib/space/managers/node-execution-manager.ts';
import {
  VALID_NODE_EXECUTION_TRANSITIONS,
  TERMINAL_NODE_EXECUTION_STATUSES,
  isValidNodeExecutionTransition,
  isNodeExecutionTerminal,
} from '../../../../src/lib/space/managers/node-execution-manager.ts';
import type { NodeExecutionStatus } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  runMigrations(db, () => {});
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

function seedExecution(
  db: BunDatabase,
  overrides: {
    id?: string;
    workflowRunId?: string;
    workflowNodeId?: string;
    agentName?: string;
    status?: string;
  } = {}
): string {
  const id = overrides.id ?? `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO node_executions
	     (id, workflow_run_id, workflow_node_id, agent_name, agent_id,
	      agent_session_id, status, result, created_at, started_at,
	      completed_at, updated_at)
	     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, ?)`
  ).run(
    id,
    overrides.workflowRunId ?? 'run-1',
    overrides.workflowNodeId ?? 'node-1',
    overrides.agentName ?? `agent-${id.slice(-6)}`,
    overrides.status ?? 'pending',
    now,
    now
  );
  return id;
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let db: BunDatabase;
let manager: NodeExecutionManager;

beforeEach(() => {
  db = makeDb();
  manager = new NodeExecutionManager(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('VALID_NODE_EXECUTION_TRANSITIONS', () => {
  test('1. has all 6 statuses as keys', () => {
    const keys = Object.keys(VALID_NODE_EXECUTION_TRANSITIONS);
    expect(keys).toContain('pending');
    expect(keys).toContain('in_progress');
    expect(keys).toContain('idle');
    expect(keys).toContain('waiting_rebind');
    expect(keys).toContain('blocked');
    expect(keys).toContain('cancelled');
    expect(keys).toHaveLength(6);
  });
});

describe('isValidNodeExecutionTransition', () => {
  test('2. pending → in_progress is valid', () => {
    expect(isValidNodeExecutionTransition('pending', 'in_progress')).toBe(true);
  });

  test('3. pending → cancelled is valid', () => {
    expect(isValidNodeExecutionTransition('pending', 'cancelled')).toBe(true);
  });

  test('4. in_progress → idle is valid', () => {
    expect(isValidNodeExecutionTransition('in_progress', 'idle')).toBe(true);
  });

  test('5. in_progress → blocked is valid', () => {
    expect(isValidNodeExecutionTransition('in_progress', 'blocked')).toBe(true);
  });

  test('6. in_progress → cancelled is valid', () => {
    expect(isValidNodeExecutionTransition('in_progress', 'cancelled')).toBe(true);
  });

  test('6b. in_progress → pending is valid (clean-recovery reset)', () => {
    // Space stop / passed rate cap / transient spawn abort reset an in-flight
    // execution to pending with a blank session binding via
    // NodeExecutionRepository.resetForCleanRecovery so the spawn path
    // re-drives it from scratch (no crash accounting).
    expect(isValidNodeExecutionTransition('in_progress', 'pending')).toBe(true);
  });

  test('7. idle → in_progress is valid (reactivation)', () => {
    expect(isValidNodeExecutionTransition('idle', 'in_progress')).toBe(true);
  });

  test('8. blocked → in_progress is valid (retry)', () => {
    expect(isValidNodeExecutionTransition('blocked', 'in_progress')).toBe(true);
  });

  test('9. blocked → cancelled is valid', () => {
    expect(isValidNodeExecutionTransition('blocked', 'cancelled')).toBe(true);
  });

  test('10. cancelled → in_progress is valid (retry)', () => {
    expect(isValidNodeExecutionTransition('cancelled', 'in_progress')).toBe(true);
  });

  test('10b. waiting_rebind → pending is valid (rebind retry)', () => {
    expect(isValidNodeExecutionTransition('waiting_rebind', 'pending')).toBe(true);
  });

  test('10c. waiting_rebind → blocked is valid (fail-forward)', () => {
    expect(isValidNodeExecutionTransition('waiting_rebind', 'blocked')).toBe(true);
  });

  test('11. pending → done is invalid', () => {
    expect(isValidNodeExecutionTransition('pending', 'done')).toBe(false);
  });

  test('12. pending → blocked is invalid', () => {
    expect(isValidNodeExecutionTransition('pending', 'blocked')).toBe(false);
  });
});

describe('isNodeExecutionTerminal', () => {
  test('13. idle is terminal', () => {
    expect(isNodeExecutionTerminal('idle')).toBe(true);
  });

  test('14. cancelled is terminal', () => {
    expect(isNodeExecutionTerminal('cancelled')).toBe(true);
  });

  test('15. pending is not terminal', () => {
    expect(isNodeExecutionTerminal('pending')).toBe(false);
  });

  test('16. in_progress is not terminal', () => {
    expect(isNodeExecutionTerminal('in_progress')).toBe(false);
  });

  test('17. blocked is not terminal', () => {
    expect(isNodeExecutionTerminal('blocked')).toBe(false);
  });

  test('17b. waiting_rebind is not terminal', () => {
    expect(isNodeExecutionTerminal('waiting_rebind')).toBe(false);
  });

  test('18. TERMINAL_NODE_EXECUTION_STATUSES size=2', () => {
    expect(TERMINAL_NODE_EXECUTION_STATUSES.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Manager tests
// ---------------------------------------------------------------------------

describe('NodeExecutionManager.setExecutionStatus', () => {
  test('19. pending → in_progress persists and stamps startedAt', async () => {
    const id = seedExecution(db, { status: 'pending' });
    const result = manager.setExecutionStatus(id, 'in_progress');
    expect(result.status).toBe('in_progress');
    expect(result.startedAt).not.toBeNull();
  });

  test('20. in_progress → idle stamps completedAt', async () => {
    const id = seedExecution(db, { status: 'in_progress' });
    const before = Date.now();
    const result = manager.setExecutionStatus(id, 'idle');
    const after = Date.now();
    expect(result.status).toBe('idle');
    expect(result.completedAt).not.toBeNull();
    expect(result.completedAt!).toBeGreaterThanOrEqual(before);
    expect(result.completedAt!).toBeLessThanOrEqual(after);
  });

  test('21. in_progress → blocked stamps completedAt', async () => {
    const id = seedExecution(db, { status: 'in_progress' });
    const result = manager.setExecutionStatus(id, 'blocked');
    expect(result.status).toBe('blocked');
    expect(result.completedAt).not.toBeNull();
  });

  test('22. in_progress → cancelled stamps completedAt', async () => {
    const id = seedExecution(db, { status: 'in_progress' });
    const result = manager.setExecutionStatus(id, 'cancelled');
    expect(result.status).toBe('cancelled');
    expect(result.completedAt).not.toBeNull();
  });

  test('23. idle → in_progress (reactivation) allows re-running', async () => {
    const id = seedExecution(db, { status: 'idle' });
    const result = manager.setExecutionStatus(id, 'in_progress');
    expect(result.status).toBe('in_progress');
  });

  test('24. blocked → in_progress (retry)', async () => {
    const id = seedExecution(db, { status: 'blocked' });
    const result = manager.setExecutionStatus(id, 'in_progress');
    expect(result.status).toBe('in_progress');
  });

  test('25. throws on not-found execution', async () => {
    expect(() => manager.setExecutionStatus('nonexistent-id', 'in_progress')).toThrow(
      /NodeExecution not found/
    );
  });

  test('26. throws on invalid transition (pending → done)', async () => {
    const id = seedExecution(db, { status: 'pending' });
    expect(() => manager.setExecutionStatus(id, 'done')).toThrow(
      /Invalid node execution status transition/
    );
    // Status must remain unchanged
    expect(manager.getById(id)?.status).toBe('pending');
  });
});

describe('NodeExecutionManager.listByWorkflowRun', () => {
  test('27. returns executions for correct run only', () => {
    seedExecution(db, { workflowRunId: 'run-a', status: 'done' });
    seedExecution(db, { workflowRunId: 'run-a', status: 'in_progress' });
    seedExecution(db, { workflowRunId: 'run-b', status: 'done' });

    const runAExecs = manager.listByWorkflowRun('run-a');
    expect(runAExecs).toHaveLength(2);

    const runBExecs = manager.listByWorkflowRun('run-b');
    expect(runBExecs).toHaveLength(1);
  });
});

describe('NodeExecutionManager.listByNode', () => {
  test('28. returns executions for specific node within run', () => {
    seedExecution(db, { workflowRunId: 'run-1', workflowNodeId: 'node-a', status: 'done' });
    seedExecution(db, { workflowRunId: 'run-1', workflowNodeId: 'node-b', status: 'in_progress' });
    seedExecution(db, {
      workflowRunId: 'run-1',
      workflowNodeId: 'node-a',
      agentName: 'agent-2',
      status: 'done',
    });

    const nodeAExecs = manager.listByNode('run-1', 'node-a');
    expect(nodeAExecs).toHaveLength(2);

    const nodeBExecs = manager.listByNode('run-1', 'node-b');
    expect(nodeBExecs).toHaveLength(1);
  });
});

describe('NodeExecutionManager.setAgentSessionId', () => {
  test('29. updates session ID', () => {
    const id = seedExecution(db, { status: 'in_progress' });
    const result = manager.setAgentSessionId(id, 'session-abc');
    expect(result?.agentSessionId).toBe('session-abc');
  });

  test('30. clears session ID with null', () => {
    const id = seedExecution(db, { status: 'in_progress' });
    manager.setAgentSessionId(id, 'session-abc');
    const result = manager.setAgentSessionId(id, null);
    expect(result?.agentSessionId).toBeNull();
  });
});

describe('NodeExecutionManager.delete', () => {
  test('31. removes execution by ID', () => {
    const id = seedExecution(db, { status: 'done' });
    expect(manager.getById(id)).not.toBeNull();
    expect(manager.delete(id)).toBe(true);
    expect(manager.getById(id)).toBeNull();
  });

  test('32. deleteByWorkflowRun removes all executions for a run', () => {
    seedExecution(db, { workflowRunId: 'run-del', workflowNodeId: 'node-a' });
    seedExecution(db, { workflowRunId: 'run-del', workflowNodeId: 'node-b' });
    seedExecution(db, { workflowRunId: 'run-keep', workflowNodeId: 'node-a' });

    expect(manager.listByWorkflowRun('run-del')).toHaveLength(2);
    expect(manager.listByWorkflowRun('run-keep')).toHaveLength(1);

    manager.deleteByWorkflowRun('run-del');

    expect(manager.listByWorkflowRun('run-del')).toHaveLength(0);
    expect(manager.listByWorkflowRun('run-keep')).toHaveLength(1);
  });
});
